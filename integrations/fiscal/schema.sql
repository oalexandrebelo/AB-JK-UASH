-- Portable SQLite/PostgreSQL DDL. Applied by the application's migrations only.
CREATE TABLE fiscal_drafts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','submitting','uncertain','pending','reconciling','authorized','rejected','cancelled','provider_cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  provider_ref TEXT NOT NULL UNIQUE,
  provider_kind TEXT,
  provider_environment TEXT,
  provider_target TEXT,
  dps_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  fiscal_summary_json TEXT NOT NULL,
  tax_review_json TEXT,
  customer_mask TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  provider_status TEXT,
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at BIGINT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fiscal_drafts_created ON fiscal_drafts(created_at,id);
CREATE UNIQUE INDEX fiscal_one_active_order ON fiscal_drafts(order_id) WHERE status NOT IN ('cancelled','rejected');
CREATE UNIQUE INDEX fiscal_one_active_dps ON fiscal_drafts(dps_key) WHERE status NOT IN ('cancelled','rejected');
CREATE TABLE fiscal_operations (
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  draft_id TEXT REFERENCES fiscal_drafts(id),
  action TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
