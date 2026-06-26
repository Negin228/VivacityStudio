const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { formatUser, buildResponse } = require('../utils/formatters');

const router = express.Router();

// ── GET /api/users/:id ─────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.*,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(r.id) as review_count
       FROM users u
       LEFT JOIN reviews r ON r.subject_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ errors: [{ code: 'not-found', title: 'User not found' }] });
    }

    const user = result.rows[0];

    // Fetch their published listings
    const listingsResult = await db.query(
      "SELECT * FROM listings WHERE author_id = $1 AND state = 'published' ORDER BY created_at DESC",
      [user.id]
    );

    const { formatListing } = require('../utils/formatters');
    const included = [];
    const listingData = listingsResult.rows.map((l) => {
      const formatted = formatListing(l, user);
      if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }
      return formatted;
    });

    const formatted = formatUser(user);
    // Attach ratings
    formatted.attributes.ratings = {
      average: parseFloat(user.avg_rating || 0).toFixed(1),
      count: parseInt(user.review_count || 0),
    };

    return res.json({
      ...buildResponse(formatted, included),
      listings: listingData,
    });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/users/:id/reviews ─────────────────────────────────────
router.get('/:id/reviews', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.display_name as author_name, u.avatar_url as author_avatar
       FROM reviews r
       JOIN users u ON u.id = r.author_id
       WHERE r.subject_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );

    return res.json({ data: result.rows });
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

module.exports = router;
