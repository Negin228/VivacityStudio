const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
const crypto = require('crypto');
const db = require('../db');
const { signToken, setTokenCookie, clearTokenCookie, requireAuth } = require('../middleware/auth');
const { formatCurrentUser, buildResponse } = require('../utils/formatters');

const router = express.Router();
const ROOT_URL = process.env.REACT_APP_CANONICAL_ROOT_URL;
const PORT = process.env.REACT_APP_DEV_API_SERVER_PORT;
const useDevApiServer = process.env.NODE_ENV === 'development' && !!PORT;
const apiBaseUrl = useDevApiServer ? `http://localhost:${PORT}` : ROOT_URL;

// ── Passport Google setup ──────────────────────────────────────────
const googleClientId = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (googleClientId && googleClientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId,
        clientSecret: googleClientSecret,
        callbackURL: `${apiBaseUrl}/api/auth/google/callback`,
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, rawReturn, profile, done) => {
        try {
          const email = profile._json.email;
          const firstName = profile._json.given_name || '';
          const lastName = profile._json.family_name || '';
          const googleId = profile.id;
          const avatarUrl = profile._json.picture || null;

          // Find existing user by google_id or email
          let userRow = await db.query(
            'SELECT * FROM users WHERE google_id = $1 OR email = $2 LIMIT 1',
            [googleId, email]
          );

          if (userRow.rows.length === 0) {
            // Create new user
            userRow = await db.query(
              `INSERT INTO users (email, first_name, last_name, display_name, google_id, avatar_url, email_verified)
               VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
              [email, firstName, lastName, `${firstName} ${lastName}`.trim(), googleId, avatarUrl]
            );
          } else if (!userRow.rows[0].google_id) {
            // Link google_id to existing email account
            await db.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, userRow.rows[0].id]);
          }

          const state = req.query.state ? JSON.parse(req.query.state) : {};
          done(null, { user: userRow.rows[0], ...state });
        } catch (err) {
          done(err, null);
        }
      }
    )
  );
}

passport.serializeUser((data, done) => done(null, data));
passport.deserializeUser((data, done) => done(null, data));

// ── POST /api/auth/signup ──────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName, userType = 'student', publicData = {} } = req.body;

    if (!email || !password) {
      return res.status(400).json({ errors: [{ code: 'missing-fields', title: 'Email and password are required' }] });
    }

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ errors: [{ code: 'email-taken', title: 'Email already registered' }] });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const displayName = `${firstName || ''} ${lastName || ''}`.trim();

    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, display_name, user_type, public_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [email, passwordHash, firstName || '', lastName || '', displayName, userType, JSON.stringify(publicData)]
    );

    const user = result.rows[0];
    const token = signToken(user);
    setTokenCookie(res, token);

    return res.status(201).json(buildResponse(formatCurrentUser(user)));
  } catch (err) {
    console.error('signup error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ errors: [{ code: 'missing-fields', title: 'Email and password are required' }] });
    }

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ errors: [{ code: 'invalid-credentials', title: 'Invalid email or password' }] });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ errors: [{ code: 'invalid-credentials', title: 'Invalid email or password' }] });
    }

    const token = signToken(user);
    setTokenCookie(res, token);

    return res.json(buildResponse(formatCurrentUser(user)));
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────
router.post('/logout', (req, res) => {
  clearTokenCookie(res);
  return res.json({ data: null });
});

// ── GET /api/auth/google ───────────────────────────────────────────
router.get('/google', (req, res, next) => {
  const from = req.query.from || null;
  const defaultReturn = req.query.defaultReturn || '/';
  const defaultConfirm = req.query.defaultConfirm || '/confirm-google';
  const state = JSON.stringify({ from, defaultReturn, defaultConfirm });

  passport.authenticate('google', {
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  })(req, res, next);
});

// ── GET /api/auth/google/callback ──────────────────────────────────
router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, data) => {
    if (err || !data) {
      console.error('Google auth error', err);
      return res.redirect(`${ROOT_URL}/login?error=google-auth-failed`);
    }

    const { user, from, defaultReturn } = data;
    const token = signToken(user);
    setTokenCookie(res, token);

    const redirectTo = from || defaultReturn || '/';
    return res.redirect(`${ROOT_URL}${redirectTo}`);
  })(req, res, next);
});

// ── GET /api/current-user ──────────────────────────────────────────
router.get('/current-user', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    if (!result.rows[0]) {
      return res.status(404).json({ errors: [{ code: 'not-found', title: 'User not found' }] });
    }
    return res.json(buildResponse(formatCurrentUser(result.rows[0])));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── PATCH /api/current-user ────────────────────────────────────────
router.patch('/current-user', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, bio, displayName, publicData, privateData } = req.body;
    const userId = req.currentUser.userId;

    const current = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const u = current.rows[0];

    const mergedPublicData = { ...(u.public_data || {}), ...(publicData || {}) };
    const mergedPrivateData = { ...(u.private_data || {}), ...(privateData || {}) };

    const result = await db.query(
      `UPDATE users
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           display_name = COALESCE($3, display_name),
           bio = COALESCE($4, bio),
           public_data = $5,
           private_data = $6
       WHERE id = $7 RETURNING *`,
      [firstName, lastName, displayName, bio, JSON.stringify(mergedPublicData), JSON.stringify(mergedPrivateData), userId]
    );

    return res.json(buildResponse(formatCurrentUser(result.rows[0])));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/auth/change-password ────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const user = result.rows[0];

    if (user.password_hash) {
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(400).json({ errors: [{ code: 'wrong-password', title: 'Current password is incorrect' }] });
      }
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    return res.json({ data: null });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/auth/request-password-reset ─────────────────────────
router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    // Don't reveal if email exists
    if (result.rows.length === 0) {
      return res.json({ data: null });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [result.rows[0].id, token, expiresAt]
    );

    // In production, send email here (nodemailer / SendGrid)
    // For now: log it so you can test
    console.log(`[DEV] Password reset link: ${ROOT_URL}/reset-password?t=${token}`);

    return res.json({ data: null });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const result = await db.query(
      `SELECT * FROM password_reset_tokens
       WHERE token = $1 AND used = false AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ errors: [{ code: 'invalid-token', title: 'Token is invalid or expired' }] });
    }

    const resetToken = result.rows[0];
    const newHash = await bcrypt.hash(newPassword, 12);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, resetToken.user_id]);
    await db.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [resetToken.id]);

    return res.json({ data: null });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

module.exports = router;
