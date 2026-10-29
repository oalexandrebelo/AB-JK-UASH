-- Private SQL store: no Supabase Auth/Data API access; application sessions are local to this schema.
-- Run as migration owner. Provision the ab_uash_app password through a secure admin channel.
BEGIN;
-- Serialize role provisioning across concurrent local migration suites.
SELECT pg_advisory_xact_lock(-883021476559275377::bigint);
CREATE SCHEMA ab_uash;
REVOKE ALL ON SCHEMA ab_uash FROM PUBLIC;
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ab_uash_app') THEN
    CREATE ROLE ab_uash_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles WHERE rolname='ab_uash_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS (
    SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='ab_uash_app'
  ) THEN
    RAISE EXCEPTION 'ab_uash_app must be an unprivileged application role without role memberships';
  END IF;
END $roles$;
SET LOCAL search_path = ab_uash,pg_catalog;
CREATE TABLE app_schema_version (singleton BIGINT PRIMARY KEY CHECK(singleton=1),version BIGINT NOT NULL);
INSERT INTO app_schema_version VALUES(1,1);

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','manager','operator','viewer')),
        active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX audit_created ON audit_events(created_at DESC);
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_keys (
        actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(actor_id, idempotency_key)
      );
      
    

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('individual','company')),postpaid BIGINT NOT NULL CHECK(postpaid IN (0,1)),
      notes TEXT NOT NULL DEFAULT '',active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE vehicles (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),plate TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,color TEXT NOT NULL DEFAULT '',category TEXT NOT NULL CHECK(category IN ('small','medium','large','motorcycle')),
      active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE services (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,price_cents BIGINT NOT NULL CHECK(price_cents>=0),
      duration_minutes BIGINT NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1440),commission_bps BIGINT NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
      active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,role_label TEXT NOT NULL DEFAULT '',base_salary_cents BIGINT NOT NULL CHECK(base_salary_cents>=0),
      commission_bps BIGINT NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE products (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,sku TEXT NOT NULL UNIQUE,unit TEXT NOT NULL DEFAULT 'un',
      quantity_milli BIGINT NOT NULL CHECK(quantity_milli>=0),min_quantity_milli BIGINT NOT NULL CHECK(min_quantity_milli>=0),
      cost_cents BIGINT NOT NULL CHECK(cost_cents>=0),active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,number BIGINT NOT NULL UNIQUE,customer_id TEXT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL CHECK(status IN ('issued','partial','paid','cancelled')),due_date TEXT NOT NULL,
      total_cents BIGINT NOT NULL CHECK(total_cents>0),notes TEXT NOT NULL DEFAULT '',
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,number BIGINT NOT NULL UNIQUE,customer_id TEXT NOT NULL REFERENCES customers(id),
      vehicle_id TEXT NOT NULL REFERENCES vehicles(id),employee_id TEXT REFERENCES employees(id),
      status TEXT NOT NULL CHECK(status IN ('quote','scheduled','waiting','in_progress','quality_check','ready','delivered','cancelled')),
      subtotal_cents BIGINT NOT NULL CHECK(subtotal_cents>=0),discount_cents BIGINT NOT NULL CHECK(discount_cents>=0),
      total_cents BIGINT NOT NULL CHECK(total_cents>=0 AND total_cents=subtotal_cents-discount_cents),
      scheduled_at TEXT,promised_at TEXT,notes TEXT NOT NULL DEFAULT '',checklist_json TEXT NOT NULL DEFAULT '[]',
      invoice_id TEXT REFERENCES invoices(id),delivered_at TEXT,settled_at TEXT,
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX orders_status ON orders(status,created_at);
    CREATE TABLE order_items (position BIGINT NOT NULL DEFAULT 0,
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL REFERENCES services(id),name TEXT NOT NULL,quantity BIGINT NOT NULL CHECK(quantity>0),
      unit_price_cents BIGINT NOT NULL CHECK(unit_price_cents>=0),duration_minutes BIGINT NOT NULL CHECK(duration_minutes>0),
      commission_bps BIGINT NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),line_total_cents BIGINT NOT NULL CHECK(line_total_cents>=0),
      discount_cents BIGINT NOT NULL CHECK(discount_cents>=0),net_cents BIGINT NOT NULL CHECK(net_cents>=0),
      commission_cents BIGINT NOT NULL CHECK(commission_cents>=0),UNIQUE(order_id,service_id)
    );
    CREATE TABLE appointments (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
      employee_id TEXT REFERENCES employees(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,items_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('scheduled','confirmed','arrived','converted','cancelled')),
      order_id TEXT UNIQUE REFERENCES orders(id),notes TEXT NOT NULL DEFAULT '',
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      CHECK(ends_at>starts_at)
    );
    CREATE INDEX appointments_interval ON appointments(employee_id,starts_at,ends_at);
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),order_id TEXT REFERENCES orders(id),
      kind TEXT NOT NULL CHECK(kind IN ('opening','purchase','adjustment_in','adjustment_out','consumption','reversal')),
      quantity_milli BIGINT NOT NULL CHECK(quantity_milli!=0),reverse_of TEXT UNIQUE REFERENCES stock_movements(id),
      notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    );
    CREATE TABLE cash_sessions (
      id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('open','closed')),opening_cents BIGINT NOT NULL CHECK(opening_cents>=0),
      counted_cents BIGINT CHECK(counted_cents>=0),difference_cents BIGINT,notes TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL,closed_at TEXT,opened_by TEXT NOT NULL REFERENCES users(id),closed_by TEXT REFERENCES users(id),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_open_cash ON cash_sessions(status) WHERE status='open';
    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,cash_session_id TEXT REFERENCES cash_sessions(id),type TEXT NOT NULL CHECK(type IN ('in','out')),
      amount_cents BIGINT NOT NULL CHECK(amount_cents>0),method TEXT NOT NULL CHECK(method IN ('cash','pix','credit','debit','transfer')),
      source TEXT NOT NULL,resource_id TEXT,category TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,source TEXT NOT NULL CHECK(source IN ('order','invoice','package')),source_id TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id),amount_cents BIGINT NOT NULL CHECK(amount_cents>0),
      method TEXT NOT NULL CHECK(method IN ('cash','pix','credit','debit','transfer')),reference TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
    );
    CREATE TABLE payment_allocations (
      payment_id TEXT NOT NULL REFERENCES payments(id),order_id TEXT NOT NULL REFERENCES orders(id),
      amount_cents BIGINT NOT NULL CHECK(amount_cents>0),PRIMARY KEY(payment_id,order_id)
    );
    CREATE INDEX payment_allocations_order ON payment_allocations(order_id);
    CREATE TABLE invoice_orders (
      invoice_id TEXT NOT NULL REFERENCES invoices(id),order_id TEXT NOT NULL REFERENCES orders(id),
      amount_cents BIGINT NOT NULL CHECK(amount_cents>0),PRIMARY KEY(invoice_id,order_id)
    );
    CREATE TABLE packages (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,service_id TEXT NOT NULL REFERENCES services(id),credits BIGINT NOT NULL CHECK(credits>0),
      price_cents BIGINT NOT NULL CHECK(price_cents>0),valid_days BIGINT NOT NULL CHECK(valid_days>0),
      active BIGINT NOT NULL DEFAULT 1 CHECK(active IN (0,1)),version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE package_sales (
      id TEXT PRIMARY KEY,package_id TEXT NOT NULL REFERENCES packages(id),customer_id TEXT NOT NULL REFERENCES customers(id),
      service_id TEXT NOT NULL REFERENCES services(id),package_name TEXT NOT NULL,service_name TEXT NOT NULL,
      credits BIGINT NOT NULL CHECK(credits>0),remaining_credits BIGINT NOT NULL CHECK(remaining_credits>=0 AND remaining_credits<=credits),
      price_cents BIGINT NOT NULL CHECK(price_cents>0),expires_at TEXT NOT NULL,payment_id TEXT REFERENCES payments(id),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE package_redemptions (
      id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),package_sale_id TEXT NOT NULL REFERENCES package_sales(id),
      service_id TEXT NOT NULL REFERENCES services(id),quantity BIGINT NOT NULL CHECK(quantity>0),amount_cents BIGINT NOT NULL CHECK(amount_cents>=0),
      reversed BIGINT NOT NULL DEFAULT 0 CHECK(reversed IN (0,1)),created_at TEXT NOT NULL,reversed_at TEXT
    );
    CREATE TABLE payroll (
      id TEXT PRIMARY KEY,period TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('draft','approved','paid')),
      notes TEXT NOT NULL DEFAULT '',paid_at TEXT,payment_method TEXT,
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE payroll_lines (
      id TEXT PRIMARY KEY,payroll_id TEXT NOT NULL REFERENCES payroll(id),employee_id TEXT NOT NULL REFERENCES employees(id),employee_name TEXT NOT NULL,
      base_cents BIGINT NOT NULL CHECK(base_cents>=0),commission_cents BIGINT NOT NULL CHECK(commission_cents>=0),
      extras_cents BIGINT NOT NULL CHECK(extras_cents>=0),deductions_cents BIGINT NOT NULL CHECK(deductions_cents>=0),
      total_cents BIGINT NOT NULL CHECK(total_cents>=0 AND total_cents=base_cents+commission_cents+extras_cents-deductions_cents),
      UNIQUE(payroll_id,employee_id)
    );
    CREATE TABLE commission_claims (
      order_id TEXT PRIMARY KEY REFERENCES orders(id),payroll_line_id TEXT NOT NULL REFERENCES payroll_lines(id),commission_cents BIGINT NOT NULL CHECK(commission_cents>=0)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id),template TEXT NOT NULL CHECK(template IN ('custom','after_service','appointment')),
      body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','queued','cancelled')),order_id TEXT REFERENCES orders(id),appointment_id TEXT REFERENCES appointments(id),
      version BIGINT NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    
  
CREATE TABLE IF NOT EXISTS order_photos (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
    image BYTEA NOT NULL CHECK(length(image) BETWEEN 20 AND 1572864),
    caption TEXT NOT NULL DEFAULT '', version BIGINT NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS order_photos_order ON order_photos(order_id,created_at);
CREATE UNIQUE INDEX users_email_casefold ON users(lower(email));
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY,attempts BIGINT NOT NULL CHECK(attempts>=0),expires_at BIGINT NOT NULL);
CREATE INDEX auth_attempts_expiry ON auth_attempts(expires_at);
-- Portable SQLite/PostgreSQL DDL. Applied by the application's migrations only.
CREATE TABLE fiscal_drafts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_version BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','submitting','uncertain','pending','reconciling','authorized','rejected','cancelled','provider_cancelled')),
  version BIGINT NOT NULL DEFAULT 1,
  provider_ref TEXT NOT NULL UNIQUE,
  provider_kind TEXT,
  provider_environment TEXT,
  provider_target TEXT,
  dps_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  fiscal_summary_json TEXT NOT NULL,
  customer_mask TEXT NOT NULL,
  payload_json TEXT,
  tax_review_json TEXT,
  payload_hash TEXT NOT NULL,
  provider_status TEXT,
  last_error_code TEXT,
  attempt_count BIGINT NOT NULL DEFAULT 0,
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

GRANT USAGE ON SCHEMA ab_uash TO ab_uash_app;
DO $permissions$
DECLARE name text; actor text;
BEGIN
  FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='ab_uash' LOOP
    EXECUTE format('REVOKE ALL ON TABLE ab_uash.%I FROM PUBLIC',name);
    EXECUTE format('ALTER TABLE ab_uash.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE ab_uash.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY application_access ON ab_uash.%I TO ab_uash_app USING (true) WITH CHECK (true)',name);
    IF name='app_schema_version' THEN
      EXECUTE format('GRANT SELECT ON ab_uash.%I TO ab_uash_app',name);
    ELSE
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ab_uash.%I TO ab_uash_app',name);
    END IF;
  END LOOP;
  FOREACH actor IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=actor) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ab_uash FROM %I',actor);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ab_uash FROM %I',actor);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ab_uash FROM %I',actor);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ab_uash FROM %I',actor);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON TABLES FROM %I',actor);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON SEQUENCES FROM %I',actor);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON FUNCTIONS FROM %I',actor);
    END IF;
  END LOOP;
END $permissions$;
ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA ab_uash REVOKE ALL ON FUNCTIONS FROM PUBLIC;
COMMIT;
