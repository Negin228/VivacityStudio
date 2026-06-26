const express = require('express');
const Stripe = require('stripe');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ROOT_URL = process.env.REACT_APP_CANONICAL_ROOT_URL;
const PORT = process.env.REACT_APP_DEV_API_SERVER_PORT;
const apiBaseUrl = process.env.NODE_ENV === 'development' && PORT
  ? `http://localhost:${PORT}`
  : ROOT_URL;

const requireStripe = (req, res, next) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on this server' });
  next();
};

// ── POST /api/checkout-stripe-recurring ───────────────────────────
// Creates a Stripe Checkout Session for a subscription booking
router.post('/checkout-stripe-recurring', requireAuth, requireStripe, async (req, res) => {
  try {
    const { userId, priceId, listingId, customerTimezone, userEmail, isFreeBooking, paymentType } = req.body;
    const lId = listingId?.uuid || listingId;

    const listingResult = await db.query('SELECT * FROM listings WHERE id = $1', [lId]);
    if (!listingResult.rows[0]) return res.status(404).json({ error: 'Listing not found' });
    const listing = listingResult.rows[0];

    // Create a transaction record in pending state
    const txResult = await db.query(
      `INSERT INTO transactions
         (listing_id, customer_id, provider_id, status, last_transition,
          booking_start, booking_end, total_amount, price_currency, booking_type, is_free, membership)
       VALUES ($1, $2, $3, 'pending', 'transition/request-payment', $4, $5, $6, $7, $8, $9, true)
       RETURNING *`,
      [
        listing.id,
        req.currentUser.userId,
        listing.author_id,
        listing.start_date,
        listing.end_date,
        isFreeBooking ? 0 : (listing.monthly_price || listing.price_amount),
        listing.price_currency || 'USD',
        isFreeBooking ? 'free' : 'paid',
        isFreeBooking ? true : false,
      ]
    );
    const tx = txResult.rows[0];

    if (isFreeBooking) {
      // Immediately confirm free subscription
      await db.query(
        `UPDATE transactions
         SET status = 'accepted', last_transition = 'transition/confirm-subscription',
             is_free = true, membership = true,
             current_period_start = $1, current_period_end = $2
         WHERE id = $3`,
        [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, tx.id]
      );
      return res.json({ url: `${ROOT_URL}/membership/success` });
    }

    // Get provider's Stripe account for Connect
    const providerResult = await db.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [listing.author_id]
    );
    const stripeAccountId = providerResult.rows[0]?.stripe_account_id;

    if (!stripeAccountId) {
      return res.status(400).json({ error: 'Provider has not connected their Stripe account yet' });
    }

    const sessionParams = {
      mode: 'subscription',
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          transactionId: tx.id,
          userId: req.currentUser.userId,
          plan: 'monthly',
          priceId,
        },
        application_fee_percent: 10,
      },
      success_url: `${apiBaseUrl}/api/stripe/success?userId=${req.currentUser.userId}&txId=${tx.id}`,
      cancel_url: `${apiBaseUrl}/api/stripe/cancel?txId=${tx.id}`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams, { stripeAccount: stripeAccountId });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('checkout-stripe-recurring error', err);
    return res.status(400).json({ error: err.message });
  }
});

// ── POST /api/create-stripe-product-and-price ─────────────────────
// Creates a Stripe Product + Price for a listing (called when teacher publishes)
router.post('/create-stripe-product-and-price', requireAuth, requireStripe, async (req, res) => {
  try {
    const { listingTitle, listingDescription, amount, monthlyPrice, listingId, stripeAccount } = req.body;
    const lId = listingId?.uuid || listingId;
    const unitAmount = monthlyPrice || amount;

    const product = await stripe.products.create(
      { name: listingTitle, description: listingDescription },
      { stripeAccount }
    );

    const price = await stripe.prices.create(
      {
        currency: 'usd',
        unit_amount: unitAmount,
        recurring: { interval: 'month' },
        product: product.id,
      },
      { stripeAccount }
    );

    // Save price ID to listing so checkout can use it
    await db.query('UPDATE listings SET price_id = $1 WHERE id = $2', [price.id, lId]);

    return res.json({ product, price });
  } catch (err) {
    console.error('create-stripe-product-and-price error', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cancel-stripe-recurring ────────────────────────────
// Cancels a Stripe subscription and transitions the transaction
router.post('/cancel-stripe-recurring', requireAuth, requireStripe, async (req, res) => {
  try {
    const { userId, transactionId } = req.body;
    const txId = transactionId?.uuid || transactionId;

    const txResult = await db.query('SELECT * FROM transactions WHERE id = $1', [txId]);
    if (!txResult.rows[0]) return res.status(404).json({ error: 'Transaction not found' });
    const tx = txResult.rows[0];

    if (!tx.is_free && tx.stripe_subscription_id) {
      const providerResult = await db.query(
        'SELECT stripe_account_id FROM users WHERE id = $1',
        [tx.provider_id]
      );
      const stripeAccountId = providerResult.rows[0]?.stripe_account_id;

      await stripe.subscriptions.cancel(tx.stripe_subscription_id, {
        stripeAccount: stripeAccountId,
      });
    }

    const updated = await db.query(
      `UPDATE transactions
       SET status = 'cancelled', last_transition = 'transition/cancel',
           membership = false
       WHERE id = $1 RETURNING *`,
      [txId]
    );

    return res.json({ data: updated.rows[0] });
  } catch (err) {
    console.error('cancel-stripe-recurring error', err);
    return res.status(400).json({ error: err.message });
  }
});

// ── GET /api/stripe/success ───────────────────────────────────────
// Stripe redirects here after successful checkout
router.get('/success', async (req, res) => {
  const { userId, txId } = req.query;
  if (txId) {
    await db.query(
      `UPDATE transactions SET status = 'accepted', last_transition = 'transition/confirm-subscription', membership = true WHERE id = $1`,
      [txId]
    ).catch(console.error);
  }
  return res.redirect(`${ROOT_URL}/membership/success`);
});

// ── GET /api/stripe/cancel ────────────────────────────────────────
// Stripe redirects here on cancelled checkout
router.get('/cancel', async (req, res) => {
  const { txId } = req.query;
  if (txId) {
    await db.query(
      `UPDATE transactions SET status = 'cancelled', last_transition = 'transition/cancel' WHERE id = $1`,
      [txId]
    ).catch(console.error);
  }
  return res.redirect(`${ROOT_URL}/`);
});

// ── POST /api/stripe/webhook ──────────────────────────────────────
// Stripe sends events here (subscriptions paid, cancelled, etc.)
// Note: This route needs raw body — mount it BEFORE json middleware
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body.toString());
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { transactionId, userId } = session.subscription_data?.metadata || {};
        const subscriptionId = session.subscription;
        if (transactionId) {
          await db.query(
            `UPDATE transactions
             SET status = 'accepted', last_transition = 'transition/confirm-subscription',
                 stripe_subscription_id = $1, membership = true
             WHERE id = $2`,
            [subscriptionId, transactionId]
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const { transactionId } = subscription.metadata || {};
        if (transactionId) {
          await db.query(
            `UPDATE transactions
             SET status = 'cancelled', last_transition = 'transition/cancel', membership = false
             WHERE id = $1`,
            [transactionId]
          );
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        // Subscription renewed — update period
        const invoice = event.data.object;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const { transactionId } = sub.metadata || {};
        if (transactionId) {
          await db.query(
            `UPDATE transactions
             SET current_period_start = $1, current_period_end = $2
             WHERE id = $3`,
            [sub.current_period_start, sub.current_period_end, transactionId]
          );
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { transactionId } = invoice.subscription_details?.metadata || {};
        if (transactionId) {
          console.warn(`Payment failed for transaction ${transactionId}`);
          // Optionally notify the user here
        }
        break;
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/create-connect-account ───────────────────────
// Teacher initiates Stripe Connect onboarding
router.post('/create-connect-account', requireAuth, requireStripe, async (req, res) => {
  try {
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const user = userResult.rows[0];

    let accountId = user.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      accountId = account.id;
      await db.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [accountId, user.id]);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${ROOT_URL}/stripe-account/new`,
      return_url: `${ROOT_URL}/stripe-account`,
      type: 'account_onboarding',
    });

    return res.json({ url: accountLink.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stripe/account-status ────────────────────────────────
router.get('/account-status', requireAuth, requireStripe, async (req, res) => {
  try {
    const userResult = await db.query('SELECT stripe_account_id, stripe_account_ready FROM users WHERE id = $1', [req.currentUser.userId]);
    const user = userResult.rows[0];

    if (!user.stripe_account_id) {
      return res.json({ connected: false, ready: false });
    }

    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    const ready = account.charges_enabled && account.payouts_enabled;

    if (ready !== user.stripe_account_ready) {
      await db.query('UPDATE users SET stripe_account_ready = $1 WHERE id = $2', [ready, user.id]);
    }

    return res.json({
      connected: true,
      ready,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
