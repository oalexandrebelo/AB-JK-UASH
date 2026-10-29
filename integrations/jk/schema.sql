-- Additive JK bridge schema. Apply after the 0.2.1 domain and fiscal migrations.
CREATE TABLE IF NOT EXISTS jk_integration_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('pix','whatsapp')),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_version INTEGER NOT NULL CHECK(order_version>0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  status TEXT NOT NULL CHECK(status IN ('prepared','submitting','active','reconciling','uncertain','pending','partial','review','test_confirmed','settled','accepted','rejected','cancelled')),
  provider TEXT,
  environment TEXT NOT NULL CHECK(environment IN ('not-configured','homologation','production')),
  account_scope TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents>=0 AND amount_cents<=1000000000),
  provider_reference TEXT,
  input_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  payment_id TEXT UNIQUE REFERENCES payments(id),
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_expires_at INTEGER,
  submitted_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS jk_integration_order ON jk_integration_records(order_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS jk_one_open_pix_per_order ON jk_integration_records(order_id)
  WHERE kind='pix' AND payment_id IS NULL AND status NOT IN ('cancelled','rejected','settled');
CREATE UNIQUE INDEX IF NOT EXISTS jk_provider_reference ON jk_integration_records(kind,provider,environment,provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS jk_integration_operations (
  actor_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  record_id TEXT REFERENCES jk_integration_records(id),
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS jk_pix_journal (
  scope TEXT NOT NULL,
  txid TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  order_id TEXT NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope,txid)
) STRICT;

CREATE TABLE IF NOT EXISTS jk_pix_receipts (
  end_to_end_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES jk_integration_records(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  received_at TEXT NOT NULL,
  refunded_cents INTEGER NOT NULL CHECK(refunded_cents>=0),
  refund_pending INTEGER NOT NULL CHECK(refund_pending IN (0,1)),
  payment_id TEXT REFERENCES payments(id),
  first_observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS jk_integration_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES jk_integration_records(id),
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  code TEXT,
  created_at TEXT NOT NULL
) STRICT;
