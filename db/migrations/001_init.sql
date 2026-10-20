-- KARAMAY initial schema.
-- Private content (journal text, mood notes) is stored only as AES-256-GCM
-- ciphertext produced by the application (see src/lib/crypto.ts).
-- Chat messages are NOT stored server-side.

CREATE TABLE subjects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('guest', 'user')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subjects_guest_inactive_idx ON subjects (last_active_at) WHERE kind = 'guest';

CREATE TABLE users (
  subject_id           uuid PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  email                text NOT NULL UNIQUE,  -- normalised (trimmed, lower-cased)
  password_hash        text NOT NULL,         -- argon2id encoded hash
  email_verified_at    timestamptz NOT NULL,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Only SHA-256 hashes of session tokens are stored; the raw token lives in the
-- client's HttpOnly cookie (web) or secure storage (mobile).
CREATE TABLE sessions (
  token_hash        bytea PRIMARY KEY,
  subject_id        uuid NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  csrf_token        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  idle_timeout_sec  integer NOT NULL CHECK (idle_timeout_sec > 0),
  revoked_at        timestamptz
);
CREATE INDEX sessions_subject_idx ON sessions (subject_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Single-use, hashed, expiring tokens for email verification (registration)
-- and password reset. A registration token carries the pending password hash
-- so that each sign-up attempt activates only its own password.
CREATE TABLE auth_tokens (
  token_hash     bytea PRIMARY KEY,
  purpose        text NOT NULL CHECK (purpose IN ('register', 'password_reset')),
  subject_id     uuid REFERENCES subjects (id) ON DELETE CASCADE,
  email          text,
  password_hash  text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_expires_idx ON auth_tokens (expires_at);

CREATE TABLE journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  key_id      integer NOT NULL,
  ciphertext  bytea NOT NULL,  -- encrypted JSON {title, body}; AAD binds owner + entry id
  prompt_id   text CHECK (prompt_id IS NULL OR length(prompt_id) <= 64),
  mood        smallint CHECK (mood BETWEEN 1 AND 5),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_owner_created_idx ON journal_entries (owner_id, created_at DESC);

CREATE TABLE mood_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  mood             smallint NOT NULL CHECK (mood BETWEEN 1 AND 5),
  key_id           integer,
  note_ciphertext  bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((key_id IS NULL) = (note_ciphertext IS NULL))
);
CREATE INDEX mood_owner_created_idx ON mood_entries (owner_id, created_at DESC);

-- Defence in depth: even if an application query forgets its owner filter,
-- Postgres only exposes rows owned by the subject bound to the transaction
-- (set with set_config('app.subject_id', ..., true) in src/db/pool.ts).
-- FORCE applies the policy to the table owner as well.
-- app.merge_from is set only inside the server-verified guest->account merge.
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_owner ON journal_entries
  USING (
    owner_id = nullif(current_setting('app.subject_id', true), '')::uuid
    OR owner_id = nullif(current_setting('app.merge_from', true), '')::uuid
  )
  WITH CHECK (owner_id = nullif(current_setting('app.subject_id', true), '')::uuid);

ALTER TABLE mood_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mood_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY mood_entries_owner ON mood_entries
  USING (
    owner_id = nullif(current_setting('app.subject_id', true), '')::uuid
    OR owner_id = nullif(current_setting('app.merge_from', true), '')::uuid
  )
  WITH CHECK (owner_id = nullif(current_setting('app.subject_id', true), '')::uuid);

-- Entitlements are written only by verified payment-provider webhooks.
CREATE TABLE entitlements (
  subject_id                uuid PRIMARY KEY REFERENCES subjects (id) ON DELETE CASCADE,
  plan                      text NOT NULL CHECK (plan IN ('free', 'premium')),
  status                    text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'expired', 'refunded')),
  provider                  text NOT NULL,
  provider_subscription_id  text NOT NULL,
  current_period_end        timestamptz,
  last_event_at             timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);

-- Idempotency ledger for payment webhooks. No card data is ever stored.
CREATE TABLE payment_events (
  provider          text NOT NULL,
  event_id          text NOT NULL,
  event_type        text NOT NULL,
  event_created_at  timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  outcome           text NOT NULL,
  PRIMARY KEY (provider, event_id)
);

-- Aggregated AI usage. Deliberately contains no subject ids and no content.
CREATE TABLE ai_usage_daily (
  day            date NOT NULL,
  model          text NOT NULL,
  feature        text NOT NULL,
  tier           text NOT NULL,
  requests       integer NOT NULL DEFAULT 0,
  blocked        integer NOT NULL DEFAULT 0,
  errors         integer NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cost_micros    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, feature, tier)
);

-- Administrative and security-relevant actions. Never contains private content.
CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
