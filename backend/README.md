# Vivacity — Standalone Setup Guide

Follow these steps **in order**. By the end your site will run with no connection to Sharetribe.

---

## Step 1 — Install PostgreSQL

**Mac (recommended):**
```bash
brew install postgresql@15
brew services start postgresql@15
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

**Windows:** Download from https://www.postgresql.org/download/windows/

---

## Step 2 — Create the database

```bash
psql -U postgres
```
Inside psql:
```sql
CREATE DATABASE vivacity;
\q
```

Run the schema:
```bash
psql -U postgres -d vivacity -f backend/db/schema.sql
```

---

## Step 3 — Copy the backend folder into your repo

Copy the entire `backend/` folder into your Vivacity repo root:
```
Vivacity/
  backend/          ← copy this here
  server/
  src/
  ...
```

---

## Step 4 — Install backend dependencies

From your Vivacity repo root:
```bash
cd backend
npm install
cd ..
```

---

## Step 5 — Replace server/apiRouter.js

The new router lives at `backend/api/router.js`.
You need to make `server/apiRouter.js` use it.

Open `server/apiRouter.js` and **replace the entire file** with:

```js
// server/apiRouter.js — now delegates to standalone backend
module.exports = require('../backend/api/router');
```

---

## Step 6 — Update server/api-util/sdk.js

Open `server/api-util/sdk.js`. Add this at the very top:

```js
// If running standalone (no Sharetribe), these functions are no-ops
// The real implementations are in backend/api/
if (!process.env.REACT_APP_SHARETRIBE_SDK_CLIENT_ID) {
  console.log('[Vivacity] Running in standalone mode — Sharetribe SDK disabled');
}
```

You do NOT need to delete sdk.js yet — the new router never calls it.

---

## Step 7 — Set up your .env file

Copy the standalone env template:
```bash
cp backend/.env.standalone .env.local
```

Edit `.env.local` and fill in:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Use `postgresql://postgres:yourpassword@localhost:5432/vivacity` |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `REACT_APP_STRIPE_PUBLISHABLE_KEY` | https://dashboard.stripe.com/test/apikeys |
| `STRIPE_SECRET_KEY` | Same page — secret key |
| `REACT_APP_MAPBOX_ACCESS_TOKEN` | https://account.mapbox.com/ |
| `REACT_APP_GOOGLE_CLIENT_ID` | https://console.cloud.google.com/apis/credentials |
| `GOOGLE_CLIENT_SECRET` | Same page |

**Leave Sharetribe variables blank or remove them.**

---

## Step 8 — Install new npm packages in the main app

From your Vivacity root:
```bash
yarn add bcrypt jsonwebtoken pg @aws-sdk/client-s3 multer
```

---

## Step 9 — Update the frontend auth calls

The frontend currently calls `/api/sign-up` (handled by old router).
The new router already handles this, but the frontend Redux ducks call
the Sharetribe SDK directly for login/logout. You need to update two files:

### src/ducks/Auth.duck.js

Find the `login` thunk. It currently calls `sdk.login(...)`.
Replace with:

```js
// OLD:
// return sdk.login({ username: email, password });

// NEW:
return fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).then(r => r.json());
```

Find the `logout` thunk. Replace `sdk.logout()` with:
```js
return fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
```

Find `fetchCurrentUser`. Replace `sdk.currentUser.show()` with:
```js
return fetch('/api/auth/current-user', { credentials: 'include' }).then(r => r.json());
```

---

## Step 10 — Start the app

```bash
yarn dev-mac   # Mac
# or
yarn dev       # Windows/Linux
```

Open http://localhost:3000

You should see the app running. Try:
1. Creating an account at `/signup`
2. Logging in at `/login`
3. Browsing listings at `/s`

---

## Step 11 — Set up Stripe (for payments)

### Get your keys
1. Go to https://dashboard.stripe.com/test/apikeys
2. Copy both keys into your `.env.local`

### Set up Stripe Connect (for teachers to receive payment)
1. Go to https://dashboard.stripe.com/test/connect/accounts/overview
2. Enable "Express" accounts

### Set up Stripe webhooks (for subscriptions)
1. Install Stripe CLI: https://stripe.com/docs/stripe-cli
2. Run: `stripe listen --forward-to localhost:3500/api/stripe/webhook`
3. Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`

---

## Step 12 — Set up S3 for images (optional but recommended)

1. Create an S3 bucket at https://s3.console.aws.amazon.com/
2. Enable public read on the bucket (or use CloudFront)
3. Create an IAM user with S3 full access
4. Add the keys to `.env.local`

Without S3, image uploads will show placeholders in development.

---

## Step 13 — Set up Google OAuth

1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `http://localhost:3500/api/auth/google/callback`
4. For production: `https://yourdomain.com/api/auth/google/callback`
5. Copy Client ID and Secret to `.env.local`

---

## Step 14 — Set up Zoom (optional)

1. Create a Zoom app at https://marketplace.zoom.us/
2. Choose "OAuth" app type
3. Set redirect URL to: `http://localhost:3500/api/auth/callback/zoom`
4. Copy Client ID and Secret to `.env.local`

---

## Deployment to Heroku

```bash
heroku create your-vivacity-app
heroku addons:create heroku-postgresql:essential-0
heroku config:set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
heroku config:set STRIPE_SECRET_KEY=sk_live_...
heroku config:set REACT_APP_STRIPE_PUBLISHABLE_KEY=pk_live_...
heroku config:set REACT_APP_MAPBOX_ACCESS_TOKEN=pk.eyJ1...
heroku config:set REACT_APP_CANONICAL_ROOT_URL=https://your-vivacity-app.herokuapp.com
heroku config:set REACT_APP_GOOGLE_CLIENT_ID=...
heroku config:set GOOGLE_CLIENT_SECRET=...

# Push schema to Heroku Postgres
heroku pg:psql < backend/db/schema.sql

git push heroku master
```

---

## What still needs the Sharetribe SDK?

**Nothing.** Once you complete the steps above, all API calls go to your PostgreSQL database.
You can remove the SDK packages when everything is working:

```bash
yarn remove sharetribe-flex-sdk sharetribe-flex-integration-sdk
```

---

## Troubleshooting

**"Cannot find module '../backend/api/router'"**
→ Make sure the `backend/` folder is inside your Vivacity repo root.

**"Database connection failed"**
→ Check `DATABASE_URL` in `.env.local`. Make sure PostgreSQL is running: `pg_isready`

**"JWT_SECRET is required"**
→ Generate one and add it to `.env.local`

**Google OAuth redirect mismatch**
→ Make sure the callback URL in Google Console matches exactly.
   Development: `http://localhost:3500/api/auth/google/callback`
