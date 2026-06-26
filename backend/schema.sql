-- Vivacity standalone database schema
-- Run this once: psql -U postgres -d vivacity -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT,                      -- null for OAuth-only users
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  display_name          TEXT,
  bio                   TEXT,
  avatar_url            TEXT,
  user_type             TEXT DEFAULT 'student',    -- 'student' | 'teacher'
  google_id             TEXT UNIQUE,
  facebook_id           TEXT UNIQUE,
  stripe_customer_id    TEXT,
  stripe_account_id     TEXT,                      -- Stripe Connect (for teachers)
  stripe_account_ready  BOOLEAN DEFAULT FALSE,
  email_verified        BOOLEAN DEFAULT FALSE,
  metadata              JSONB DEFAULT '{}',        -- featured, etc.
  public_data           JSONB DEFAULT '{}',        -- timezone, bio, website, etc.
  private_data          JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- LISTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS listings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  price_amount      INTEGER NOT NULL DEFAULT 0,    -- in cents (e.g. 5000 = $50.00)
  price_currency    TEXT NOT NULL DEFAULT 'USD',
  monthly_price     INTEGER,                       -- for recurring subscriptions (cents)
  state             TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published' | 'closed'
  -- Location
  location_lat      DOUBLE PRECISION,
  location_lng      DOUBLE PRECISION,
  location_address  TEXT,
  -- Category / metadata
  category          TEXT,
  class_duration    TEXT,                          -- '30_min' | '60_min' | '90_min'
  weekly_days       JSONB DEFAULT '[]',            -- [{value:"2",label:"Tuesday"}]
  payment_type      JSONB DEFAULT '[]',            -- [{value:"one_time"}, {value:"recurring"}]
  timezone          TEXT DEFAULT 'America/Los_Angeles',
  start_date        TIMESTAMPTZ,
  end_date          TIMESTAMPTZ,
  start_date_string TEXT,                          -- human-readable for display
  next_class        TEXT,
  last_class        BIGINT,                        -- unix timestamp
  stock             INTEGER DEFAULT 1,
  price_id          TEXT,                          -- Stripe price ID (for recurring)
  listing_type      TEXT DEFAULT 'default',        -- 'default' | 'free'
  -- Zoom
  zoom_data         JSONB DEFAULT '{}',            -- {series: [{start_url, join_url, ...}]}
  -- Images stored as array of URLs
  images            JSONB DEFAULT '[]',
  -- Catch-all for any other public/private fields
  public_data       JSONB DEFAULT '{}',
  private_data      JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS listings_author_id_idx ON listings(author_id);
CREATE INDEX IF NOT EXISTS listings_state_idx ON listings(state);
CREATE INDEX IF NOT EXISTS listings_category_idx ON listings(category);

-- ============================================================
-- AVAILABILITY PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  type        TEXT DEFAULT 'availability/plan/time',
  timezone    TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  entries     JSONB DEFAULT '[]', -- [{dayOfWeek:"mon",startTime:"09:00",endTime:"17:00",seats:1}]
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS availability_plans_listing_idx ON availability_plans(listing_id);

-- ============================================================
-- AVAILABILITY EXCEPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  seats       INTEGER NOT NULL DEFAULT 0,  -- 0 = blocked, >0 = extra availability
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS avail_exceptions_listing_idx ON availability_exceptions(listing_id);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                UUID NOT NULL REFERENCES listings(id),
  customer_id               UUID NOT NULL REFERENCES users(id),
  provider_id               UUID NOT NULL REFERENCES users(id),
  -- State machine: pending→accepted→completed | declined | cancelled
  status                    TEXT NOT NULL DEFAULT 'pending',
  last_transition           TEXT,
  process_name              TEXT DEFAULT 'flex-hourly-default-process',
  -- Booking window
  booking_start             TIMESTAMPTZ,
  booking_end               TIMESTAMPTZ,
  booking_type              TEXT DEFAULT 'paid',    -- 'paid' | 'free'
  seats                     INTEGER DEFAULT 1,
  -- Money (all in cents)
  total_amount              INTEGER,
  provider_payout           INTEGER,
  platform_fee              INTEGER,
  price_currency            TEXT DEFAULT 'USD',
  -- Stripe
  stripe_payment_intent_id  TEXT,
  stripe_subscription_id    TEXT,
  stripe_transfer_id        TEXT,
  -- Zoom
  zoom_meeting_url          TEXT,
  zoom_host_url             TEXT,
  -- Metadata stored by the app
  metadata                  JSONB DEFAULT '{}',  -- customerTime, providerTime, timezones
  -- Subscription
  is_free                   BOOLEAN DEFAULT FALSE,
  membership                BOOLEAN DEFAULT FALSE,
  current_period_start      BIGINT,
  current_period_end        BIGINT,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_customer_idx ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS transactions_provider_idx ON transactions(provider_id);
CREATE INDEX IF NOT EXISTS transactions_listing_idx  ON transactions(listing_id);
CREATE INDEX IF NOT EXISTS transactions_status_idx   ON transactions(status);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_transaction_idx ON messages(transaction_id);

-- ============================================================
-- REVIEWS
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  author_id       UUID NOT NULL REFERENCES users(id),
  subject_id      UUID NOT NULL REFERENCES users(id),
  listing_id      UUID REFERENCES listings(id),
  rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content         TEXT,
  state           TEXT DEFAULT 'published',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (transaction_id, author_id)
);

CREATE INDEX IF NOT EXISTS reviews_subject_idx ON reviews(subject_id);
CREATE INDEX IF NOT EXISTS reviews_listing_idx ON reviews(listing_id);

-- ============================================================
-- PASSWORD RESET TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Trigger: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at') THEN
    CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_listings_updated_at') THEN
    CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_transactions_updated_at') THEN
    CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
