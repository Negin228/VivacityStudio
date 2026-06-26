const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { formatListing, formatUser, buildResponse } = require('../utils/formatters');

const router = express.Router();

// ── S3 setup (optional — falls back to storing URL directly) ───────
let s3Client = null;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const uploadToS3 = async (file, prefix = 'listings') => {
  if (!s3Client) throw new Error('S3 not configured');
  const key = `${prefix}/${Date.now()}-${file.originalname.replace(/\s/g, '-')}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${key}`;
};

// Helper: fetch listing with author
const getListingWithAuthor = async (listingId) => {
  const result = await db.query(
    `SELECT l.*, u.first_name, u.last_name, u.display_name, u.avatar_url,
            u.email, u.user_type, u.stripe_account_id, u.stripe_account_ready,
            u.bio as author_bio, u.public_data as author_public_data,
            u.metadata as author_metadata
     FROM listings l
     JOIN users u ON l.author_id = u.id
     WHERE l.id = $1`,
    [listingId]
  );
  return result.rows[0];
};

// ── GET /api/listings ──────────────────────────────────────────────
// Matches sdk.listings.query(params) usage in the frontend
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      keywords,
      pub_category,
      pub_paymentType,
      'pub_price.amount.gte': priceMin,
      'pub_price.amount.lte': priceMax,
      origin,
      page = 1,
      perPage = 24,
      sort = 'createdAt',
      include = '',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(perPage);
    const conditions = ["l.state = 'published'"];
    const params = [];

    if (keywords) {
      params.push(`%${keywords}%`);
      conditions.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
    }
    if (pub_category) {
      params.push(pub_category);
      conditions.push(`l.category = $${params.length}`);
    }
    if (priceMin) {
      params.push(parseInt(priceMin));
      conditions.push(`l.price_amount >= $${params.length}`);
    }
    if (priceMax) {
      params.push(parseInt(priceMax));
      conditions.push(`l.price_amount <= $${params.length}`);
    }
    if (origin) {
      // e.g. "lat,lng,radius" — basic bounding box
      const [lat, lng] = origin.split(',').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        conditions.push(
          `(l.location_lat IS NOT NULL AND
            ABS(l.location_lat - ${lat}) < 2 AND
            ABS(l.location_lng - ${lng}) < 2)`
        );
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*) FROM listings l ${where}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    params.push(parseInt(perPage));
    params.push(offset);

    const result = await db.query(
      `SELECT l.*,
              u.id as u_id, u.first_name, u.last_name, u.display_name,
              u.avatar_url, u.user_type, u.bio as author_bio,
              u.public_data as author_public_data, u.metadata as author_metadata,
              u.stripe_account_id, u.stripe_account_ready
       FROM listings l
       JOIN users u ON l.author_id = u.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const included = [];
    const wantsAuthor = include.includes('author');

    const data = result.rows.map((row) => {
      const authorRow = {
        id: row.u_id,
        first_name: row.first_name,
        last_name: row.last_name,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        user_type: row.user_type,
        bio: row.author_bio,
        public_data: row.author_public_data,
        metadata: row.author_metadata,
        stripe_account_id: row.stripe_account_id,
        stripe_account_ready: row.stripe_account_ready,
      };
      if (wantsAuthor) included.push(formatUser(authorRow));
      const formatted = formatListing(row, authorRow);
      if (formatted._imageData) {
        included.push(...formatted._imageData);
        delete formatted._imageData;
      }
      return formatted;
    });

    return res.json({
      ...buildResponse(data, included),
      meta: {
        totalItems,
        totalPages: Math.ceil(totalItems / parseInt(perPage)),
        page: parseInt(page),
        perPage: parseInt(perPage),
      },
    });
  } catch (err) {
    console.error('listings.query error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/listings/:id ──────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const row = await getListingWithAuthor(req.params.id);
    if (!row) return res.status(404).json({ errors: [{ code: 'not-found', title: 'Listing not found' }] });

    const authorRow = {
      id: row.author_id,
      first_name: row.first_name,
      last_name: row.last_name,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      user_type: row.user_type,
      bio: row.author_bio,
      public_data: row.author_public_data,
      metadata: row.author_metadata,
      stripe_account_id: row.stripe_account_id,
      stripe_account_ready: row.stripe_account_ready,
    };

    const formatted = formatListing(row, authorRow);
    const included = [formatUser(authorRow)];
    if (formatted._imageData) {
      included.push(...formatted._imageData);
      delete formatted._imageData;
    }

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/own-listings ──────────────────────────────────────────
// Teacher's own listings (all states)
router.get('/own/all', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM listings WHERE author_id = $1 ORDER BY created_at DESC',
      [req.currentUser.userId]
    );
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const author = userResult.rows[0];

    const included = [];
    const data = result.rows.map((row) => {
      const formatted = formatListing(row, author);
      if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }
      return formatted;
    });

    return res.json(buildResponse(data, included));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── GET /api/own-listings/:id ──────────────────────────────────────
router.get('/own/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM listings WHERE id = $1 AND author_id = $2',
      [req.params.id, req.currentUser.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ errors: [{ code: 'not-found' }] });

    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const formatted = formatListing(result.rows[0], userResult.rows[0]);
    const included = [];
    if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/listings ─────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      title, description, price, publicData = {}, privateData = {}, images = [],
    } = req.body;

    const {
      category, classDuration, weeklyDays, paymentType, timezone,
      startDate, endDate, startDateString, nextClass, stock, type,
      monthlyPrice, location,
    } = publicData;

    const priceAmount = price?.amount ?? 0;
    const priceCurrency = price?.currency ?? 'USD';
    const lat = publicData?.location?.selectedPlace?.origin?.lat ?? null;
    const lng = publicData?.location?.selectedPlace?.origin?.lng ?? null;
    const address = publicData?.location?.search ?? publicData?.location?.address ?? null;

    const result = await db.query(
      `INSERT INTO listings
         (author_id, title, description, price_amount, price_currency, state,
          category, class_duration, weekly_days, payment_type, timezone,
          start_date, end_date, start_date_string, next_class, stock, listing_type,
          monthly_price, location_lat, location_lng, location_address,
          images, public_data, private_data)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [
        req.currentUser.userId, title, description, priceAmount, priceCurrency,
        category, classDuration,
        JSON.stringify(weeklyDays || []),
        JSON.stringify(paymentType || []),
        timezone,
        startDate || null, endDate || null, startDateString || null, nextClass || null,
        stock ?? 1, type || 'default', monthlyPrice || null,
        lat, lng, address,
        JSON.stringify(images),
        JSON.stringify(publicData),
        JSON.stringify(privateData),
      ]
    );

    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const formatted = formatListing(result.rows[0], userResult.rows[0]);
    const included = [];
    if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }

    return res.status(201).json(buildResponse(formatted, included));
  } catch (err) {
    console.error('create listing error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── PATCH /api/listings/:id ────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const listingId = req.params.id;
    const userId = req.currentUser.userId;

    // Verify ownership
    const check = await db.query('SELECT id FROM listings WHERE id = $1 AND author_id = $2', [listingId, userId]);
    if (!check.rows[0]) return res.status(403).json({ errors: [{ code: 'forbidden' }] });

    const current = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    const cur = current.rows[0];

    const { title, description, price, publicData = {}, privateData = {}, images } = req.body;

    const mergedPublic = { ...(cur.public_data || {}), ...publicData };
    const mergedPrivate = { ...(cur.private_data || {}), ...privateData };

    const {
      category, classDuration, weeklyDays, paymentType, timezone,
      startDate, endDate, startDateString, nextClass, stock, type, monthlyPrice,
    } = mergedPublic;

    const lat = publicData?.location?.selectedPlace?.origin?.lat ?? cur.location_lat;
    const lng = publicData?.location?.selectedPlace?.origin?.lng ?? cur.location_lng;
    const address = publicData?.location?.search ?? publicData?.location?.address ?? cur.location_address;

    const result = await db.query(
      `UPDATE listings SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         price_amount = COALESCE($3, price_amount),
         price_currency = COALESCE($4, price_currency),
         category = COALESCE($5, category),
         class_duration = COALESCE($6, class_duration),
         weekly_days = COALESCE($7, weekly_days),
         payment_type = COALESCE($8, payment_type),
         timezone = COALESCE($9, timezone),
         start_date = COALESCE($10, start_date),
         end_date = COALESCE($11, end_date),
         start_date_string = COALESCE($12, start_date_string),
         next_class = COALESCE($13, next_class),
         stock = COALESCE($14, stock),
         listing_type = COALESCE($15, listing_type),
         monthly_price = COALESCE($16, monthly_price),
         location_lat = COALESCE($17, location_lat),
         location_lng = COALESCE($18, location_lng),
         location_address = COALESCE($19, location_address),
         images = COALESCE($20, images),
         public_data = $21,
         private_data = $22
       WHERE id = $23 RETURNING *`,
      [
        title, description,
        price?.amount, price?.currency,
        category, classDuration,
        weeklyDays ? JSON.stringify(weeklyDays) : null,
        paymentType ? JSON.stringify(paymentType) : null,
        timezone, startDate, endDate, startDateString, nextClass, stock, type, monthlyPrice,
        lat, lng, address,
        images ? JSON.stringify(images) : null,
        JSON.stringify(mergedPublic), JSON.stringify(mergedPrivate),
        listingId,
      ]
    );

    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const formatted = formatListing(result.rows[0], userResult.rows[0]);
    const included = [];
    if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    console.error('update listing error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/listings/:id/publish ────────────────────────────────
router.post('/:id/publish', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await db.query('SELECT id FROM listings WHERE id = $1 AND author_id = $2', [id, req.currentUser.userId]);
    if (!check.rows[0]) return res.status(403).json({ errors: [{ code: 'forbidden' }] });

    const result = await db.query("UPDATE listings SET state = 'published' WHERE id = $1 RETURNING *", [id]);
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const formatted = formatListing(result.rows[0], userResult.rows[0]);
    const included = [];
    if (formatted._imageData) { included.push(...formatted._imageData); delete formatted._imageData; }

    return res.json(buildResponse(formatted, included));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/listings/:id/close ──────────────────────────────────
router.post('/:id/close', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await db.query('SELECT id FROM listings WHERE id = $1 AND author_id = $2', [id, req.currentUser.userId]);
    if (!check.rows[0]) return res.status(403).json({ errors: [{ code: 'forbidden' }] });

    const result = await db.query("UPDATE listings SET state = 'closed' WHERE id = $1 RETURNING *", [id]);
    const userResult = await db.query('SELECT * FROM users WHERE id = $1', [req.currentUser.userId]);
    const formatted = formatListing(result.rows[0], userResult.rows[0]);

    return res.json(buildResponse(formatted));
  } catch (err) {
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

// ── POST /api/images/upload ────────────────────────────────────────
router.post('/images/upload', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ errors: [{ code: 'no-file', title: 'No file provided' }] });

    let url;
    if (s3Client && process.env.S3_BUCKET) {
      url = await uploadToS3(req.file);
    } else {
      // Dev fallback: return a placeholder (won't work in prod without S3)
      url = `https://via.placeholder.com/800x600?text=${encodeURIComponent(req.file.originalname)}`;
      console.warn('[DEV] S3 not configured — using placeholder image URL');
    }

    return res.json({
      data: {
        id: { uuid: `img-${Date.now()}` },
        type: 'image',
        attributes: {
          variants: {
            'landscape-crop': { url, width: 400, height: 267 },
            'landscape-crop2x': { url, width: 800, height: 533 },
            'scaled-small': { url, width: 320, height: 320 },
            'scaled-medium': { url, width: 750, height: 750 },
            'scaled-large': { url, width: 1024, height: 1024 },
          },
        },
      },
    });
  } catch (err) {
    console.error('image upload error', err);
    return res.status(500).json({ errors: [{ code: 'server-error', title: err.message }] });
  }
});

module.exports = router;
