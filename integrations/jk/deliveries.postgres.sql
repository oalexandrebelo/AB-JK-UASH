-- Additive delivery schema. Apply after the host domain migration with its private schema as search_path.
-- Grant the application role access and keep these tables outside publicly exposed schemas.
-- This file is provided for provisioning; the delivery suite was executed with SQLite.

  CREATE TABLE IF NOT EXISTS jk_deliveries (
    id TEXT PRIMARY KEY,
    appointment_id TEXT REFERENCES appointments(id),order_id TEXT REFERENCES orders(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
    kind TEXT NOT NULL CHECK(kind IN ('pickup','return')),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,address_json TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('scheduled','en_route','completed','cancelled','failed')),
    dispatched_at TEXT,completed_at TEXT,received_by TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    CHECK((appointment_id IS NOT NULL AND order_id IS NULL) OR (appointment_id IS NULL AND order_id IS NOT NULL)),
    CHECK(ends_at>starts_at)
  );
  CREATE INDEX IF NOT EXISTS jk_deliveries_interval ON jk_deliveries(employee_id,starts_at,ends_at);
  CREATE UNIQUE INDEX IF NOT EXISTS jk_delivery_appointment_leg ON jk_deliveries(appointment_id,kind)
    WHERE appointment_id IS NOT NULL AND status NOT IN ('cancelled','failed');
  CREATE UNIQUE INDEX IF NOT EXISTS jk_delivery_order_leg ON jk_deliveries(order_id,kind)
    WHERE order_id IS NOT NULL AND status NOT IN ('cancelled','failed');
  CREATE TABLE IF NOT EXISTS jk_delivery_events (
    id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES jk_deliveries(id),
    actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,
    from_status TEXT,to_status TEXT NOT NULL,delivery_version INTEGER NOT NULL CHECK(delivery_version>0),
    reason TEXT NOT NULL DEFAULT '',snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(delivery_id,delivery_version)
  );
  CREATE INDEX IF NOT EXISTS jk_delivery_events_delivery ON jk_delivery_events(delivery_id,delivery_version);
