import { readFileSync } from 'node:fs';
import { transaction } from './db.mjs';

export function migrateDomain(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 2) return;
  transaction(db, () => db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('individual','company')),postpaid INTEGER NOT NULL CHECK(postpaid IN (0,1)),
      notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE vehicles (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),plate TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,color TEXT NOT NULL DEFAULT '',category TEXT NOT NULL CHECK(category IN ('small','medium','large','motorcycle')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE services (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>=0),
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1440),commission_bps INTEGER NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,role_label TEXT NOT NULL DEFAULT '',base_salary_cents INTEGER NOT NULL CHECK(base_salary_cents>=0),
      commission_bps INTEGER NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,sku TEXT NOT NULL UNIQUE,unit TEXT NOT NULL DEFAULT 'un',
      quantity_milli INTEGER NOT NULL CHECK(quantity_milli>=0),min_quantity_milli INTEGER NOT NULL CHECK(min_quantity_milli>=0),
      cost_cents INTEGER NOT NULL CHECK(cost_cents>=0),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,customer_id TEXT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL CHECK(status IN ('issued','partial','paid','cancelled')),due_date TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK(total_cents>0),notes TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,customer_id TEXT NOT NULL REFERENCES customers(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),employee_id TEXT REFERENCES employees(id),
      status TEXT NOT NULL CHECK(status IN ('quote','scheduled','waiting','in_progress','quality_check','ready','delivered','cancelled')),
      subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents>=0),discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),
      total_cents INTEGER NOT NULL CHECK(total_cents>=0 AND total_cents=subtotal_cents-discount_cents),
      scheduled_at TEXT,promised_at TEXT,notes TEXT NOT NULL DEFAULT '',checklist_json TEXT NOT NULL DEFAULT '[]',
      invoice_id TEXT REFERENCES invoices(id),delivered_at TEXT,settled_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX orders_status ON orders(status,created_at);
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL REFERENCES services(id),name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),duration_minutes INTEGER NOT NULL CHECK(duration_minutes>0),
      commission_bps INTEGER NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),line_total_cents INTEGER NOT NULL CHECK(line_total_cents>=0),
      discount_cents INTEGER NOT NULL CHECK(discount_cents>=0),net_cents INTEGER NOT NULL CHECK(net_cents>=0),
      commission_cents INTEGER NOT NULL CHECK(commission_cents>=0),UNIQUE(order_id,service_id)
    ) STRICT;
    CREATE TABLE appointments (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      employee_id TEXT REFERENCES employees(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,items_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('scheduled','confirmed','arrived','converted','cancelled')),
      order_id TEXT UNIQUE REFERENCES orders(id),notes TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      CHECK(ends_at>starts_at)
    ) STRICT;
    CREATE INDEX appointments_interval ON appointments(employee_id,starts_at,ends_at);
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),order_id TEXT REFERENCES orders(id),
      kind TEXT NOT NULL CHECK(kind IN ('opening','purchase','adjustment_in','adjustment_out','consumption','reversal')),
      quantity_milli INTEGER NOT NULL CHECK(quantity_milli!=0),reverse_of TEXT UNIQUE REFERENCES stock_movements(id),
      notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE cash_sessions (
      id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('open','closed')),opening_cents INTEGER NOT NULL CHECK(opening_cents>=0),
      counted_cents INTEGER CHECK(counted_cents>=0),difference_cents INTEGER,notes TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL,closed_at TEXT,opened_by TEXT NOT NULL REFERENCES users(id),closed_by TEXT REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX one_open_cash ON cash_sessions(status) WHERE status='open';
    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,cash_session_id TEXT REFERENCES cash_sessions(id),type TEXT NOT NULL CHECK(type IN ('in','out')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0),method TEXT NOT NULL CHECK(method IN ('cash','pix','credit','debit','transfer')),
      source TEXT NOT NULL,resource_id TEXT,category TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,source TEXT NOT NULL CHECK(source IN ('order','invoice','package')),source_id TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      method TEXT NOT NULL CHECK(method IN ('cash','pix','credit','debit','transfer')),reference TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE payment_allocations (
      payment_id TEXT NOT NULL REFERENCES payments(id),order_id TEXT NOT NULL REFERENCES orders(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0),PRIMARY KEY(payment_id,order_id)
    ) STRICT;
    CREATE INDEX payment_allocations_order ON payment_allocations(order_id);
    CREATE TABLE invoice_orders (
      invoice_id TEXT NOT NULL REFERENCES invoices(id),order_id TEXT NOT NULL REFERENCES orders(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0),PRIMARY KEY(invoice_id,order_id)
    ) STRICT;
    CREATE TABLE packages (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,service_id TEXT NOT NULL REFERENCES services(id),credits INTEGER NOT NULL CHECK(credits>0),
      price_cents INTEGER NOT NULL CHECK(price_cents>0),valid_days INTEGER NOT NULL CHECK(valid_days>0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE package_sales (
      id TEXT PRIMARY KEY,package_id TEXT NOT NULL REFERENCES packages(id),customer_id TEXT NOT NULL REFERENCES customers(id),
      service_id TEXT NOT NULL REFERENCES services(id),package_name TEXT NOT NULL,service_name TEXT NOT NULL,
      credits INTEGER NOT NULL CHECK(credits>0),remaining_credits INTEGER NOT NULL CHECK(remaining_credits>=0 AND remaining_credits<=credits),
      price_cents INTEGER NOT NULL CHECK(price_cents>0),expires_at TEXT NOT NULL,payment_id TEXT REFERENCES payments(id),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE package_redemptions (
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),package_sale_id TEXT NOT NULL REFERENCES package_sales(id),
      service_id TEXT NOT NULL REFERENCES services(id),quantity INTEGER NOT NULL CHECK(quantity>0),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
      reversed INTEGER NOT NULL DEFAULT 0 CHECK(reversed IN (0,1)),created_at TEXT NOT NULL,reversed_at TEXT
    ) STRICT;
    CREATE TABLE payroll (
      id TEXT PRIMARY KEY,period TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('draft','approved','paid')),
      notes TEXT NOT NULL DEFAULT '',paid_at TEXT,payment_method TEXT,
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE payroll_lines (
      id TEXT PRIMARY KEY,payroll_id TEXT NOT NULL REFERENCES payroll(id),employee_id TEXT NOT NULL REFERENCES employees(id),employee_name TEXT NOT NULL,
      base_cents INTEGER NOT NULL CHECK(base_cents>=0),commission_cents INTEGER NOT NULL CHECK(commission_cents>=0),
      extras_cents INTEGER NOT NULL CHECK(extras_cents>=0),deductions_cents INTEGER NOT NULL CHECK(deductions_cents>=0),
      total_cents INTEGER NOT NULL CHECK(total_cents>=0 AND total_cents=base_cents+commission_cents+extras_cents-deductions_cents),
      UNIQUE(payroll_id,employee_id)
    ) STRICT;
    CREATE TABLE commission_claims (
      order_id TEXT PRIMARY KEY REFERENCES orders(id),payroll_line_id TEXT NOT NULL REFERENCES payroll_lines(id),commission_cents INTEGER NOT NULL CHECK(commission_cents>=0)
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),template TEXT NOT NULL CHECK(template IN ('custom','after_service','appointment')),
      body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','queued','cancelled')),order_id TEXT REFERENCES orders(id),appointment_id TEXT REFERENCES appointments(id),
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
  `));
}

// Additive local migrations preserve compatibility with SQLite backup schema 2.
export function migrateStorage(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS auth_attempts (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts>=0), expires_at INTEGER NOT NULL
    ) STRICT; CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON auth_attempts(expires_at);`);
    if (!db.prepare('PRAGMA table_info(order_items)').all().some(column => column.name === 'position')) {
      db.exec('ALTER TABLE order_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0; UPDATE order_items SET position=rowid;');
    }
    if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='fiscal_drafts'").get()) {
      db.exec(readFileSync(new URL('../integrations/fiscal/schema.sql', import.meta.url), 'utf8'));
    }
  });
}
