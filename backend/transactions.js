const express = require('express');
const Stripe = require('stripe');
const moment = require('moment-timezone');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { formatTransaction, formatBooking, formatListing, formatUser, buildResponse } = require('../utils/formatters');

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ROOT_URL = process.env.REACT_APP_CANONICAL_ROOT_URL;
const PORT = process.env.REACT_APP_DEV_API_SERVER_PORT;
const apiBaseUrl = process.env.NODE_ENV === 'development' && PORT
  ? `http://localhost:${PORT}`
  : ROOT_URL;

const PLATFORM_FEE_PERCENT = 10;

// ── Helper: calculate line items (matches your existing lineItems.js logic) ──
const calculateLineItems = (listing, bookingData) => {
  const { price_amount, price_currency, monthly_price, listing_type } = listing;
  const { type: paymentType, stockReservationQuantity, quantity } = bookingData || {};

  const isRecurring = paymentType === 'recurring';
  const isFree = listing_type === 'free';

  const unitPrice = isRecurring && monthly_price ? monthly_price : price_amount;
  const effectivePrice = isFree ? 0 : unitPrice;
  const qty = stockReservationQuantity || quantity || 1;
  const subtotal = effectivePrice * qty;
  const platformFee = Math.round(subtotal * (PLATFORM_FEE_PERCENT / 100));
  const providerPayout = subtotal - platformFee;

  return { subtotal, platformFee, providerPayout, qty, currency: price_currency || 'USD' };
};

// ── POST /api/transaction-line-items ──────────────────────────────
// Called by checkout page before initiating — returns price breakdown
router.post('/transaction-line-items', requireAuth, async (req, res) => {
  try {
    const { bodyParams } = req.body;
    const listingId = bodyParams?.params?.listingId?.uuid || bodyParams?.params?.listingId;

    const listingResult = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (!listingResult.rows[0]) {
      return res.status(404).json({ errors: [{ code: 'not-found', title: 'Listing not found' }] });
    }

    const listing = listingResult.rows[0];
    const { subtotal, platformFee, providerPayout, qty, currency } = calculateLineItems(listing, bodyParams?.params);

    const lineItems = [
      {
        code: 'line-item/units',
        unitPrice: { amount: listing.listing_type === 'free' ? 0 : listing.price_amount, currency },
        quantity: qty,
        includeFor: ['customer', 'provider'],
        lineTotal: { amount: subtotal, currency },
      },
      {
        code: 'line-item/provider-commission',
        unitPrice: { amount: subtotal, currency },
        percentage: -PLATFORM_FEE_PERCENT,
        includeFor: ['provider'],
        lineTotal: { amount: -platformFee, currency },
      },
    ];

    return res.json({ data: lineItems });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/initiate-privileged ─────────────────────────────────
// Initiates a transaction (one-time booking flow)
router.post('/initiate-privileged', requireAuth, async (req, res) => {
  try {
    const { bodyParams, isSpeculative } = req.body;
    const params = bodyParams?.params || {};
    const listingId = params.listingId?.uuid || params.listingId;
    const customerTimezone = params.customerTimezone;

    const listingResult = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (!listingResult.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });
    const listing = listingResult.rows[0];

    const providerResult = await db.query('SELECT * FROM users WHERE id = $1', [listing.author_id]);
    const customerResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);

    const { subtotal, platformFee, providerPayout, qty, currency } = calculateLineItems(listing, params);

    // Build time metadata (matches your existing logic)
    const providerTimezone = listing.timezone || 'America/New_York';
    const time = params.nextClass || listing.start_date;
    const dateFormat = 'dddd, MMMM Do YYYY, h:mm a z';

    let customerTime = '', providerTime = '';
    try {
      const inputDate = params.nextClass
        ? moment.tz(time, dateFormat, customerTimezone)
        : moment.tz(time, customerTimezone);
      customerTime = inputDate.clone().tz(customerTimezone).format('dddd, MMMM Do YYYY, h:mm a');
      providerTime = inputDate.clone().tz(providerTimezone).format('dddd, MMMM Do YYYY, h:mm a');
    } catch (_) {}

    if (isSpeculative) {
      // Return a speculative (preview) transaction without saving
      return res.json({
        data: {
          id: { uuid: 'speculative' },
          type: 'transaction',
          attributes: {
            payinTotal: { amount: subtotal, currency },
            payoutTotal: { amount: providerPayout, currency },
            lineItems: [],
          },
        },
      });
    }

    const txResult = await db.query(
      `INSERT INTO transactions
         (listing_id, customer_id, provider_id, status, last_transition,
          booking_start, booking_end, seats, total_amount, platform_fee,
          provider_payout, price_currency, booking_type, metadata)
       VALUES ($1,$2,$3,'pending','transition/request-payment',$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        listing.id, req.currentUser.userId, listing.author_id,
        listing.start_date, listing.end_date,
        qty, subtotal, platformFee, providerPayout, currency,
        listing.listing_type === 'free' ? 'free' : 'paid',
        JSON.stringify({ customerTime, providerTime, customerTimezone, providerTimezone }),
      ]
    );

    const tx = txResult.rows[0];
    const formatted = formatTransaction(tx, listing, customerResult.rows[0], providerResult.rows[0]);
    if (tx.booking_start) {
      formatted.relationships.booking = { data: { id: { uuid: `${tx.id}-booking` }, type: 'booking' } };
    }
    const included = [
      formatBooking(tx),
      formatUser(providerResult.rows[0]),
    ];

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    console.error('initiate-privileged error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/transition-privileged ───────────────────────────────
// Transitions a transaction (e.g. after payment confirmation)
router.post('/transition-privileged', requireAuth, async (req, res) => {
  try {
    const { bodyParams, isSpeculative } = req.body;
    const params = bodyParams?.params || {};
    const txId = params.id?.uuid || params.id;
    const transition = bodyParams?.transition;

    const txResult = await db.query(
      `SELECT t.*, l.*, u_p.stripe_account_id, u_p.stripe_account_ready
       FROM transactions t
       JOIN listings l ON l.id = t.listing_id
       JOIN users u_p ON u_p.id = t.provider_id
       WHERE t.id = $1`,
      [txId]
    );
    if (!txResult.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });

    const tx = txResult.rows[0];

    if (isSpeculative) {
      return res.json({ data: { id: { uuid: txId }, type: 'transaction', attributes: {} } });
    }

    let newStatus = tx.status;
    const transitionMap = {
      'transition/request-payment': 'pending',
      'transition/confirm-payment': 'accepted',
      'transition/accept': 'accepted',
      'transition/decline': 'declined',
      'transition/cancel': 'cancelled',
      'transition/complete': 'completed',
      'transition/confirm-subscription': 'accepted',
      'transition/cancel-after-delivery': 'cancelled',
      'transition/cancel-after-review': 'cancelled',
    };

    if (transition && transitionMap[transition]) {
      newStatus = transitionMap[transition];
    }

    const mergedMeta = { ...(tx.metadata || {}), ...(params.metadata || {}) };
    const updated = await db.query(
      `UPDATE transactions SET status = $1, last_transition = $2, metadata = $3 WHERE id = $4 RETURNING *`,
      [newStatus, transition || tx.last_transition, JSON.stringify(mergedMeta), txId]
    );

    const formatted = formatTransaction(updated.rows[0]);
    if (updated.rows[0].booking_start) {
      formatted.relationships.booking = { data: { id: { uuid: `${txId}-booking` }, type: 'booking' } };
    }

    return res.json(buildResponse(formatted, [formatBooking(updated.rows[0])]));
  } catch (err) {
    console.error('transition-privileged error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/transition-confirm-payment ──────────────────────────
// Called after Stripe payment confirmed on client side
router.post('/transition-confirm-payment', requireAuth, async (req, res) => {
  try {
    const { params } = req.body;
    const txId = params?.id?.uuid || params?.id;

    const updated = await db.query(
      `UPDATE transactions
       SET status = 'accepted', last_transition = 'transition/confirm-payment'
       WHERE id = $1 AND customer_id = $2 RETURNING *`,
      [txId, req.currentUser.userId]
    );

    if (!updated.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });

    const formatted = formatTransaction(updated.rows[0]);
    return res.json(buildResponse(formatted));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/accept-transaction ──────────────────────────────────
// Provider accepts a transaction (checks start date not in past)
router.post('/accept-transaction', requireAuth, async (req, res) => {
  try {
    const { id, userTimeZone } = req.body;
    const txId = id?.uuid || id;

    const txResult = await db.query(
      `SELECT t.*, l.start_date, l.timezone as listing_timezone
       FROM transactions t
       JOIN listings l ON l.id = t.listing_id
       WHERE t.id = $1 AND t.provider_id = $2`,
      [txId, req.currentUser.userId]
    );
    if (!txResult.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });

    const tx = txResult.rows[0];
    const providerMeta = tx.metadata?.providerTime || tx.start_date;
    const startDate = moment.tz(providerMeta, userTimeZone || tx.listing_timezone || 'UTC');
    const now = moment.tz(new Date(), userTimeZone || 'UTC');

    if (startDate.isBefore(now)) {
      return res.status(400).json({ message: 'Transaction cannot be accepted because class start date is in past.' });
    }

    const updated = await db.query(
      `UPDATE transactions SET status = 'accepted', last_transition = 'transition/accept' WHERE id = $1 RETURNING *`,
      [txId]
    );

    const formatted = formatTransaction(updated.rows[0]);
    return res.json(buildResponse(formatted));
  } catch (err) {
    console.error('accept-transaction error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/check-transaction ───────────────────────────────────
// Returns transaction with listing details (used in various UIs)
router.post('/check-transaction', requireAuth, async (req, res) => {
  try {
    const { id, userTimeZone } = req.body;
    const txId = id?.uuid || id;

    const txResult = await db.query(
      `SELECT t.*, l.start_date as listing_start_date, l.timezone as listing_timezone,
              l.title as listing_title
       FROM transactions t
       JOIN listings l ON l.id = t.listing_id
       WHERE t.id = $1`,
      [txId]
    );

    if (!txResult.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });

    return res.json({ data: txResult.rows[0] });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/transactions ─────────────────────────────────────────
// Returns transactions for the current user (as customer or provider)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { only, lastTransitions, page = 1, perPage = 100 } = req.query;
    const userId = req.currentUser.userId;
    const offset = (parseInt(page) - 1) * parseInt(perPage);

    let roleCondition = '(t.customer_id = $1 OR t.provider_id = $1)';
    if (only === 'order') roleCondition = 't.customer_id = $1';
    if (only === 'sale') roleCondition = 't.provider_id = $1';

    const result = await db.query(
      `SELECT t.*,
              l.title as listing_title, l.images as listing_images,
              u_c.display_name as customer_name, u_c.avatar_url as customer_avatar,
              u_p.display_name as provider_name, u_p.avatar_url as provider_avatar
       FROM transactions t
       JOIN listings l ON l.id = t.listing_id
       JOIN users u_c ON u_c.id = t.customer_id
       JOIN users u_p ON u_p.id = t.provider_id
       WHERE ${roleCondition}
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(perPage), offset]
    );

    const data = result.rows.map((row) => {
      const tx = formatTransaction(row);
      tx.attributes.listingTitle = row.listing_title;
      return tx;
    });

    return res.json(buildResponse(data));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/transactions/:id ─────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*,
              l.id as l_id, l.title, l.price_amount, l.price_currency, l.images, l.state as l_state,
              l.start_date, l.end_date, l.timezone, l.public_data, l.private_data, l.zoom_data,
              u_c.id as c_id, u_c.first_name as c_first, u_c.last_name as c_last, u_c.display_name as c_name, u_c.avatar_url as c_avatar, u_c.email as c_email, u_c.user_type as c_type, u_c.public_data as c_pubdata, u_c.metadata as c_meta, u_c.stripe_account_id as c_stripe,
              u_p.id as p_id, u_p.first_name as p_first, u_p.last_name as p_last, u_p.display_name as p_name, u_p.avatar_url as p_avatar, u_p.email as p_email, u_p.user_type as p_type, u_p.public_data as p_pubdata, u_p.metadata as p_meta, u_p.stripe_account_id as p_stripe, u_p.stripe_account_ready as p_stripe_ready
       FROM transactions t
       JOIN listings l ON l.id = t.listing_id
       JOIN users u_c ON u_c.id = t.customer_id
       JOIN users u_p ON u_p.id = t.provider_id
       WHERE t.id = $1 AND (t.customer_id = $2 OR t.provider_id = $2)`,
      [req.params.id, req.currentUser.userId]
    );

    if (!result.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });
    const row = result.rows[0];

    const listing = { id: row.l_id, title: row.title, price_amount: row.price_amount, price_currency: row.price_currency, images: row.images, state: row.l_state, start_date: row.start_date, end_date: row.end_date, timezone: row.timezone, public_data: row.public_data, private_data: row.private_data, zoom_data: row.zoom_data, author_id: row.p_id };
    const customer = { id: row.c_id, first_name: row.c_first, last_name: row.c_last, display_name: row.c_name, avatar_url: row.c_avatar, email: row.c_email, user_type: row.c_type, public_data: row.c_pubdata, metadata: row.c_meta, stripe_account_id: row.c_stripe };
    const provider = { id: row.p_id, first_name: row.p_first, last_name: row.p_last, display_name: row.p_name, avatar_url: row.p_avatar, email: row.p_email, user_type: row.p_type, public_data: row.p_pubdata, metadata: row.p_meta, stripe_account_id: row.p_stripe, stripe_account_ready: row.p_stripe_ready };

    // Fetch messages
    const msgs = await db.query(
      'SELECT * FROM messages WHERE transaction_id = $1 ORDER BY created_at ASC',
      [row.id]
    );

    const formatted = formatTransaction(row, listing, customer, provider);
    const included = [
      formatListing(listing, provider),
      formatUser(customer),
      formatUser(provider),
      formatBooking(row),
      ...msgs.rows.map((m) => ({
        id: { uuid: m.id },
        type: 'message',
        attributes: { content: m.content, createdAt: m.created_at },
        relationships: { sender: { data: { id: { uuid: m.sender_id }, type: 'user' } } },
      })),
    ];

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    console.error('get transaction error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/messages ─────────────────────────────────────────────
router.post('/messages', requireAuth, async (req, res) => {
  try {
    const { transactionId, content } = req.body;
    const txId = transactionId?.uuid || transactionId;

    // Verify user is party to this transaction
    const txCheck = await db.query(
      'SELECT id FROM transactions WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)',
      [txId, req.currentUser.userId]
    );
    if (!txCheck.rows[0]) return res.status(403).json({ errors: [{ code: 'forbidden' }] });

    const result = await db.query(
      'INSERT INTO messages (transaction_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
      [txId, req.currentUser.userId, content]
    );

    return res.status(201).json({
      data: {
        id: { uuid: result.rows[0].id },
        type: 'message',
        attributes: {
          content: result.rows[0].content,
          createdAt: result.rows[0].created_at,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/reviews ──────────────────────────────────────────────
router.post('/reviews', requireAuth, async (req, res) => {
  try {
    const { transactionId, rating, content, subjectId } = req.body;
    const txId = transactionId?.uuid || transactionId;
    const subjectUUID = subjectId?.uuid || subjectId;

    const txCheck = await db.query(
      'SELECT * FROM transactions WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)',
      [txId, req.currentUser.userId]
    );
    if (!txCheck.rows[0]) return res.status(403).json({ errors: [{ code: 'forbidden' }] });
    const tx = txCheck.rows[0];

    const result = await db.query(
      `INSERT INTO reviews (transaction_id, author_id, subject_id, listing_id, rating, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (transaction_id, author_id) DO UPDATE SET rating = EXCLUDED.rating, content = EXCLUDED.content
       RETURNING *`,
      [txId, req.currentUser.userId, subjectUUID, tx.listing_id, rating, content]
    );

    return res.status(201).json({ data: { id: { uuid: result.rows[0].id }, type: 'review', attributes: result.rows[0] } });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

module.exports = router;
