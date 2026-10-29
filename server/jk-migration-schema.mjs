// Additive, private SQLite tables. Domain schema/version and authentication stay unchanged.
export function initializeJkMigration(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS jk_migration_batches (
      id TEXT PRIMARY KEY,source TEXT NOT NULL,scope TEXT NOT NULL,input_hash TEXT NOT NULL,
      preview_hash TEXT NOT NULL,report_json TEXT NOT NULL,actor_id TEXT REFERENCES users(id),committed_at TEXT NOT NULL,
      UNIQUE(source,scope,input_hash)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_migration_records (
      source TEXT NOT NULL,scope TEXT NOT NULL,entity TEXT NOT NULL,origin_key TEXT NOT NULL,
      source_id TEXT,provenance TEXT NOT NULL CHECK(provenance IN ('source-id','snapshot-row')),
      snapshot_hash TEXT,source_row INTEGER,target_id TEXT NOT NULL,row_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL REFERENCES jk_migration_batches(id),
      PRIMARY KEY(source,scope,entity,origin_key),UNIQUE(entity,target_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_history_orders (
      id TEXT PRIMARY KEY,number TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES customers(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),status TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>=0),discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),
      total_cents INTEGER NOT NULL CHECK(total_cents>=0 AND total_cents=subtotal_cents-discount_cents),
      notes TEXT NOT NULL,created_at TEXT NOT NULL,delivered_at TEXT,
      batch_id TEXT NOT NULL REFERENCES jk_migration_batches(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_history_order_items (
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES jk_history_orders(id),
      service_id TEXT NOT NULL REFERENCES services(id),name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity>0),unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
      line_total_cents INTEGER NOT NULL CHECK(line_total_cents=quantity*unit_price_cents),
      discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),net_cents INTEGER NOT NULL CHECK(net_cents=line_total_cents-discount_cents AND net_cents>=0),
      commission_cents INTEGER NOT NULL CHECK(commission_cents>=0),
      batch_id TEXT NOT NULL REFERENCES jk_migration_batches(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_history_payments (
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES jk_history_orders(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      method TEXT NOT NULL CHECK(method IN ('cash','pix','credit','debit','transfer')),reference TEXT NOT NULL,
      created_at TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES jk_migration_batches(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS jk_migration_source_rows (
      id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES jk_migration_batches(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),snapshot_hash TEXT NOT NULL,source_row INTEGER NOT NULL,
      data_json TEXT NOT NULL,UNIQUE(snapshot_hash,source_row)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jk_history_orders_customer ON jk_history_orders(customer_id,created_at);
    CREATE INDEX IF NOT EXISTS jk_history_items_order ON jk_history_order_items(order_id);
    CREATE INDEX IF NOT EXISTS jk_history_payments_order ON jk_history_payments(order_id);
  `);
}
