import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { requireRole } from './security.mjs';
import { READERS, MANAGERS, now, publicRecord, paginate, settings, businessDate, localMidnight, addDays, dateRange } from './domain-core.mjs';
import { ORDER_STATUSES, orderView, appointmentView } from './domain-orders.mjs';

async function amount(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const result = (await statement.get(...params)).amount || 0n;
  assert(result >= 0n && result <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'AMOUNT_LIMIT', 'O relatório excede o limite numérico permitido.');
  return Number(result);
}

async function receivables(db) {
  // Aggregate each ledger once before joining orders; joining raw payments and
  // raw redemptions would multiply rows and incorrectly subtract receipts.
  return (await amount(db, `WITH paid AS (
      SELECT order_id,SUM(amount_cents) AS cents FROM payment_allocations GROUP BY order_id
    ), credited AS (
      SELECT order_id,SUM(amount_cents) AS cents FROM package_redemptions WHERE reversed=0 GROUP BY order_id
    ) SELECT COALESCE(SUM(o.total_cents-COALESCE(p.cents,0)-COALESCE(c.cents,0)),0) AS amount
    FROM orders o LEFT JOIN paid p ON p.order_id=o.id LEFT JOIN credited c ON c.order_id=o.id
    WHERE o.status NOT IN ('quote','cancelled')`));
}

export async function dashboardRoutes(ctx) {
  if (ctx.pathname !== '/api/dashboard' || ctx.method !== 'GET') return null;
  const user = requireRole(ctx.session, READERS);
  const zone = (await settings(ctx.db)).timezone;
  const today = businessDate(now(), zone), start = localMidnight(today, zone), end = localMidnight(addDays(today, 1), zone);
  const ordersByStatus = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0]));
  for (const row of (await ctx.db.prepare('SELECT status,COUNT(*) AS count FROM orders GROUP BY status').all())) ordersByStatus[row.status] = row.count;
  const stockAlerts = (await ctx.db.prepare('SELECT * FROM products WHERE active=1 AND quantity_milli<=min_quantity_milli ORDER BY quantity_milli,name LIMIT 8').all()).map((row) => ({ ...publicRecord(row), lowStock: true }));
  const item = {
    businessDate: today, timezone: zone, ordersByStatus,
    openOrders: ORDER_STATUSES.filter((status) => !['quote','delivered','cancelled'].includes(status)).reduce((sum, status) => sum + ordersByStatus[status], 0),
    lowStockCount: (await ctx.db.prepare('SELECT COUNT(*) AS count FROM products WHERE active=1 AND quantity_milli<=min_quantity_milli').get()).count,
    appointmentsToday: (await ctx.db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE starts_at>=? AND starts_at<? AND status NOT IN ('cancelled','converted')").get(start, end)).count,
    recentOrders: (await Promise.all((await ctx.db.prepare('SELECT id FROM orders ORDER BY created_at DESC,number DESC LIMIT 8').all()).map(async (row) => (await orderView(ctx.db, row.id))))),
    upcomingAppointments: (await Promise.all((await ctx.db.prepare("SELECT id FROM appointments WHERE starts_at>=? AND status NOT IN ('cancelled','converted') ORDER BY starts_at,id LIMIT 8").all(now())).map(async (row) => (await appointmentView(ctx.db, row.id))))),
    stockAlerts,
  };
  if (MANAGERS.includes(user.role)) {
    item.receivedTodayCents = (await amount(ctx.db, 'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM payments WHERE created_at>=? AND created_at<?', [start,end]));
    item.receivableCents = (await receivables(ctx.db));
  }
  return { data: { item } };
}

export async function reportRoutes(ctx) {
  if (ctx.pathname !== '/api/reports' || ctx.method !== 'GET') return null;
  requireRole(ctx.session, MANAGERS);
  const type = v.choice(ctx.url.searchParams.get('type') || 'summary', 'type', ['summary','sales','services','employees','stock','cash']);
  const range = (await dateRange(ctx.db, ctx.url));
  const summary = {
    receivedCents: (await amount(ctx.db, 'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM payments WHERE created_at>=? AND created_at<?', [range.start,range.end])),
    deliveredCents: (await amount(ctx.db, "SELECT COALESCE(SUM(total_cents),0) AS amount FROM orders WHERE status='delivered' AND delivered_at>=? AND delivered_at<?", [range.start,range.end])),
    openReceivableCents: (await receivables(ctx.db)),
    orderCount: (await amount(ctx.db, 'SELECT COUNT(*) AS amount FROM orders WHERE created_at>=? AND created_at<?', [range.start,range.end])),
  };
  let sql, params = [range.start,range.end];
  if (type === 'summary') {
    sql = "SELECT 'received' AS id,'receivedCents' AS metric,'Recebido no período' AS label,CAST(? AS BIGINT) AS value,'cents' AS unit UNION ALL SELECT 'delivered','deliveredCents','Serviços entregues no período',CAST(? AS BIGINT),'cents' UNION ALL SELECT 'receivable','openReceivableCents','Saldo atual a receber',CAST(? AS BIGINT),'cents' UNION ALL SELECT 'orders','orderCount','Ordens criadas no período',CAST(? AS BIGINT),'count'";
    params = [summary.receivedCents,summary.deliveredCents,summary.openReceivableCents,summary.orderCount];
  } else if (type === 'sales') {
    sql = 'SELECT p.id,p.created_at,p.source,c.name AS customer_name,p.method,p.amount_cents,p.reference FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.created_at>=? AND p.created_at<? ORDER BY p.created_at DESC,p.id';
  } else if (type === 'services') {
    sql = `SELECT i.service_id AS id,i.service_id,i.name,SUM(i.quantity) AS quantity,SUM(i.line_total_cents) AS gross_cents,SUM(i.net_cents) AS net_cents,SUM(i.commission_cents) AS commission_cents
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status='delivered' AND o.delivered_at>=? AND o.delivered_at<? GROUP BY i.service_id,i.name ORDER BY net_cents DESC,i.name`;
  } else if (type === 'employees') {
    sql = `SELECT e.id,e.id AS employee_id,e.name,COUNT(DISTINCT o.id) AS orders,SUM(i.net_cents) AS net_cents,SUM(i.commission_cents) AS commission_cents
      FROM employees e JOIN orders o ON o.employee_id=e.id JOIN order_items i ON i.order_id=o.id WHERE o.status='delivered' AND o.delivered_at>=? AND o.delivered_at<? GROUP BY e.id,e.name ORDER BY net_cents DESC,e.name`;
  } else if (type === 'stock') {
    sql = 'SELECT id,name,sku,unit,quantity_milli,min_quantity_milli,cost_cents,(quantity_milli<=min_quantity_milli) AS low_stock FROM products ORDER BY name,id'; params = [];
  } else {
    sql = 'SELECT id,cash_session_id,created_at,type,source,method,amount_cents,category FROM cash_movements WHERE created_at>=? AND created_at<? ORDER BY created_at DESC,id';
  }
  const { rows, page } = (await paginate(ctx.db, ctx.url, sql, params));
  const items = rows.map((row) => { const item = publicRecord(row); if (type === 'stock') item.lowStock = Boolean(item.lowStock); return item; });
  return { data: { items, page, summary, period: { from: range.from, to: range.to, timezone: (await settings(ctx.db)).timezone }, type, positionAsOf: now() } };
}
