/**
 * NEW apiRouter.js
 *
 * Drop-in replacement for server/apiRouter.js
 * All Sharetribe SDK calls have been removed.
 * Each route is served from your own PostgreSQL database.
 *
 * COPY THIS FILE to server/apiRouter.js in your Vivacity repo.
 */

const express = require('express');
const passport = require('passport');
const bodyParser = require('body-parser');

const authRoutes        = require('../../backend/api/auth');
const listingsRoutes    = require('../../backend/api/listings');
const transactionRoutes = require('../../backend/api/transactions');
const stripeRoutes      = require('../../backend/api/stripe');
const zoomRoutes        = require('../../backend/api/zoom');
const usersRoutes       = require('../../backend/api/users');

const router = express.Router();

// ── Middleware ────────────────────────────────────────────────────
router.use(passport.initialize());

// Stripe webhook needs raw body — must be before json parser
router.use('/stripe/webhook', express.raw({ type: 'application/json' }));

// Parse JSON and Transit bodies
router.use(bodyParser.json({ limit: '10mb' }));
router.use(bodyParser.urlencoded({ extended: true }));
router.use(
  bodyParser.text({ type: 'application/transit+json' })
);

// ── Route groups ──────────────────────────────────────────────────

// Auth: signup, login, logout, Google OAuth, password reset
router.use('/auth', authRoutes);

// Current user (convenience routes that frontend calls directly)
router.get('/current-user',   authRoutes);    // proxied from authRoutes
router.patch('/current-user', authRoutes);

// Users / Profiles
router.use('/users', usersRoutes);

// Listings (public + own)
router.use('/listings',     listingsRoutes);
router.use('/own-listings', listingsRoutes); // own/* routes handled inside

// Image upload (mounted under /listings/images/upload)
// already handled inside listingsRoutes

// Transactions, messages, reviews
router.use('/', transactionRoutes);   // /transaction-line-items, /initiate-privileged, etc.
router.use('/transactions', transactionRoutes);
router.use('/messages', transactionRoutes);
router.use('/reviews', transactionRoutes);

// Stripe
router.use('/stripe',                       stripeRoutes);
router.use('/checkout-stripe-recurring',    stripeRoutes);
router.use('/create-stripe-product-and-price', stripeRoutes);
router.use('/cancel-stripe-recurring',      stripeRoutes);

// Zoom
router.use('/', zoomRoutes);  // /zoom, /auth/callback/zoom

// ── Legacy compatibility stubs ────────────────────────────────────
// These routes existed in the old apiRouter and are called by the frontend.
// They are now all handled by the routes above — but listed here for reference.
//
// POST /initiate-privileged       → transactionRoutes
// POST /transition-privileged     → transactionRoutes
// POST /transaction-line-items    → transactionRoutes
// POST /transition-confirm-payment → transactionRoutes
// POST /accept-transaction        → transactionRoutes
// POST /check-transaction         → transactionRoutes
// POST /sign-up                   → authRoutes (/auth/signup)
// POST /auth/create-user-with-idp → authRoutes
// GET  /auth/google               → authRoutes
// GET  /auth/google/callback      → authRoutes
// GET  /auth/callback/zoom        → zoomRoutes
// GET  /auth/callback/zoom/extend → zoomRoutes
// GET  /zoom                      → zoomRoutes
// POST /checkout-stripe-recurring → stripeRoutes
// POST /create-stripe-product-and-price → stripeRoutes
// POST /cancel-stripe-recurring   → stripeRoutes
// GET  /stripe/success            → stripeRoutes
// GET  /stripe/cancel             → stripeRoutes

// Sign-up called from frontend as /api/sign-up (not /api/auth/signup)
router.post('/sign-up', (req, res, next) => {
  req.url = '/signup';
  authRoutes(req, res, next);
});

module.exports = router;
