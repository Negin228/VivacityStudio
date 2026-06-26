const express = require('express');
const fetch = require('cross-fetch');
const moment = require('moment-timezone');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const zoomClientId = process.env.REACT_APP_ZOOM_CLIENT_ID;
const zoomClientSecret = process.env.ZOOM_CLIENT_SECRET;
const ROOT_URL = process.env.REACT_APP_CANONICAL_ROOT_URL;
const PORT = process.env.REACT_APP_DEV_API_SERVER_PORT;
const apiBaseUrl = process.env.NODE_ENV === 'development' && PORT
  ? `http://localhost:${PORT}`
  : ROOT_URL;
const ERROR_PAGE_URL = `${ROOT_URL}/zoom-error?error=true`;

// ── Helpers ────────────────────────────────────────────────────────
const getZoomToken = async (code, backURL) => {
  const hash = Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64');
  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=authorization_code&code=${code}&redirect_uri=${apiBaseUrl}/api/auth/callback/zoom?backurl=${backURL}`,
    { method: 'POST', headers: { Authorization: `Basic ${hash}` } }
  );
  const data = await response.json();
  if (response.status >= 400) throw Object.assign(new Error(), data);
  return data.access_token;
};

const getZoomUser = async (access_token) => {
  const response = await fetch('https://api.zoom.us/v2/users/me', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await response.json();
  if (response.status >= 400) throw Object.assign(new Error(), data);
  return data;
};

const createZoomMeeting = async (params, userId, token) => {
  if (params.type === 2) {
    params = {
      ...params,
      start_time: moment(params.start_time).format('YYYY-MM-DDTHH:mm:ssZ'),
      settings: { join_before_host: true, waiting_room: false },
    };
  }
  const response = await fetch(`https://api.zoom.us/v2/users/${userId}/meetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return response.json();
};

const calculateApiCalls = (weeklyDays) => {
  const totalMeetings = weeklyDays.length * 26;
  if (totalMeetings <= 60) return { apiCalls: 1, endTimes: totalMeetings };
  return { apiCalls: Math.ceil(totalMeetings / 60), endTimes: 60 };
};

const calculateRemainingMeetings = (weeklyDays, seriesNumber) => {
  const total = weeklyDays.length * 26;
  return Math.max(0, Math.min(60, total - seriesNumber * 60));
};

// ── GET /api/auth/callback/zoom ────────────────────────────────────
// Called by Zoom OAuth after teacher authorizes
router.get('/auth/callback/zoom', async (req, res) => {
  const { code, backurl: backURL } = req.query;
  try {
    if (!code || !backURL) return res.redirect(ERROR_PAGE_URL);
    const listingId = backURL.split('/')?.[3];
    if (!listingId) return res.redirect(ERROR_PAGE_URL);

    const access_token = await getZoomToken(code, backURL);
    const zoomUser = await getZoomUser(access_token);

    const listingResult = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (!listingResult.rows[0]) return res.redirect(ERROR_PAGE_URL);
    const listing = listingResult.rows[0];

    const { class_duration, weekly_days, payment_type, timezone: listingTimezone, start_date } = listing;
    const weeklyDays = Array.isArray(weekly_days) ? weekly_days : [];
    const paymentTypes = Array.isArray(payment_type) ? payment_type : [];
    const duration = { '30_min': 30, '60_min': 60, '90_min': 90 }[class_duration?.key || class_duration] || 60;
    const isRecurring = paymentTypes.some((t) => t.value === 'recurring');

    const meetingParams = {
      start_time: moment.tz(start_date, listingTimezone).format('YYYY-MM-DDTHH:mm:ssZ'),
      timezone: listingTimezone,
      type: isRecurring ? 8 : 2,
      duration,
      topic: (listing.title || '').slice(0, 199),
    };

    let allMeetingUrls = [];
    let lastClass;

    if (isRecurring && weeklyDays.length > 0) {
      const { apiCalls, endTimes } = calculateApiCalls(weeklyDays);
      meetingParams.recurrence = {
        type: 2,
        repeat_interval: 1,
        weekly_days: weeklyDays.map((d) => d.value).join(','),
        end_times: endTimes,
      };

      let currentMeeting = await createZoomMeeting(meetingParams, zoomUser.id, access_token);
      allMeetingUrls.push({
        start_url: currentMeeting.start_url,
        join_url: currentMeeting.join_url,
        start_date: currentMeeting.occurrences?.[0]?.start_time,
        end_date: currentMeeting.occurrences?.[currentMeeting.occurrences.length - 1]?.start_time,
      });

      for (let i = 1; i < apiCalls; i++) {
        const remaining = calculateRemainingMeetings(weeklyDays, i);
        if (remaining <= 0) break;
        const lastOccurrence = currentMeeting.occurrences?.[currentMeeting.occurrences.length - 1]?.start_time;
        const nextParams = {
          ...meetingParams,
          start_time: moment(lastOccurrence).tz(listingTimezone).add(7, 'days').format('YYYY-MM-DDTHH:mm:ssZ'),
          recurrence: { ...meetingParams.recurrence, end_times: Math.min(60, remaining) },
        };
        const nextMeeting = await createZoomMeeting(nextParams, zoomUser.id, access_token);
        if (nextMeeting.occurrences?.length > 0) {
          allMeetingUrls.push({
            start_url: nextMeeting.start_url,
            join_url: nextMeeting.join_url,
            start_date: nextMeeting.occurrences[0].start_time,
            end_date: nextMeeting.occurrences[nextMeeting.occurrences.length - 1].start_time,
          });
          currentMeeting = nextMeeting;
        }
      }
      lastClass = moment(currentMeeting.occurrences?.[currentMeeting.occurrences.length - 1]?.start_time).unix();
    } else {
      const meeting = await createZoomMeeting(meetingParams, zoomUser.id, access_token);
      allMeetingUrls.push({
        start_url: meeting.start_url,
        join_url: meeting.join_url,
        start_date: meetingParams.start_time,
        end_date: meetingParams.start_time,
      });
      lastClass = moment(meetingParams.start_time).unix();
    }

    await db.query(
      `UPDATE listings
       SET zoom_data = $1, last_class = $2,
           public_data = public_data || '{"timeUpdated": false}'::jsonb
       WHERE id = $3`,
      [JSON.stringify({ series: allMeetingUrls }), lastClass, listingId]
    );

    return res.redirect(`${ROOT_URL}${backURL}`);
  } catch (err) {
    console.error('Zoom callback error', err);
    return res.redirect(ERROR_PAGE_URL);
  }
});

// ── GET /api/auth/callback/zoom/extend ─────────────────────────────
// Extends an existing recurring Zoom meeting series
router.get('/auth/callback/zoom/extend', async (req, res) => {
  const { code, backurl: backURL } = req.query;
  try {
    if (!code || !backURL) return res.redirect(ERROR_PAGE_URL);
    const listingId = backURL.split('/')?.[3];
    if (!listingId) return res.redirect(ERROR_PAGE_URL);

    const access_token = await getZoomToken(code, backURL);
    const zoomUser = await getZoomUser(access_token);

    const listingResult = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    if (!listingResult.rows[0]) return res.redirect(ERROR_PAGE_URL);
    const listing = listingResult.rows[0];
    const existingSeries = listing.zoom_data?.series || [];

    const { class_duration, weekly_days, timezone: listingTimezone } = listing;
    const weeklyDays = Array.isArray(weekly_days) ? weekly_days : [];
    const duration = { '30_min': 30, '60_min': 60, '90_min': 90 }[class_duration?.key || class_duration] || 60;

    // Get last meeting end date from existing series
    const lastEndDate = existingSeries[existingSeries.length - 1]?.end_date;
    if (!lastEndDate) return res.redirect(ERROR_PAGE_URL);

    const newParams = {
      start_time: moment(lastEndDate).tz(listingTimezone).add(7, 'days').format('YYYY-MM-DDTHH:mm:ssZ'),
      timezone: listingTimezone,
      type: 8,
      duration,
      topic: (listing.title || '').slice(0, 199),
      recurrence: {
        type: 2,
        repeat_interval: 1,
        weekly_days: weeklyDays.map((d) => d.value).join(','),
        end_times: Math.min(60, weeklyDays.length * 26),
      },
    };

    const newMeeting = await createZoomMeeting(newParams, zoomUser.id, access_token);
    const newEntry = {
      start_url: newMeeting.start_url,
      join_url: newMeeting.join_url,
      start_date: newMeeting.occurrences?.[0]?.start_time,
      end_date: newMeeting.occurrences?.[newMeeting.occurrences.length - 1]?.start_time,
    };
    const lastClass = moment(newEntry.end_date).unix();

    await db.query(
      `UPDATE listings SET zoom_data = $1, last_class = $2 WHERE id = $3`,
      [JSON.stringify({ series: [...existingSeries, newEntry] }), lastClass, listingId]
    );

    return res.redirect(`${ROOT_URL}${backURL}`);
  } catch (err) {
    console.error('Zoom extend error', err);
    return res.redirect(ERROR_PAGE_URL);
  }
});

// ── GET /api/zoom ──────────────────────────────────────────────────
// Returns Zoom meeting data for a listing (join/host URLs for current time slot)
router.get('/zoom', requireAuth, async (req, res) => {
  try {
    const { listingId, transactionId } = req.query;

    let listing;
    if (listingId) {
      const r = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
      listing = r.rows[0];
    } else if (transactionId) {
      const r = await db.query(
        'SELECT l.* FROM listings l JOIN transactions t ON t.listing_id = l.id WHERE t.id = $1',
        [transactionId]
      );
      listing = r.rows[0];
    }

    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const zoomData = listing.zoom_data || {};
    const series = zoomData.series || [];

    if (series.length === 0) {
      return res.json({ data: null, message: 'No Zoom meeting configured for this listing' });
    }

    // Find the current/next upcoming meeting
    const now = moment();
    let currentMeeting = series.find((s) => moment(s.start_date).isAfter(now)) || series[series.length - 1];

    return res.json({ data: currentMeeting });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
