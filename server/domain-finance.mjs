import { assert } from './errors.mjs';
import * as v from './validation.mjs';
import { requireRole } from './security.mjs';
import { OPERATORS, MANAGERS, READERS, METHODS, now, id, money, quantity, memo, publicRecord, record, version, insert, update, changed, mutate, paginate, orderBalance, touchOrder, cashMovement, cashExpected, stockChange, receive, floorRatio, sumSafe } from './domain-core.mjs';
import { orderView } from './domain-orders.mjs';

export async function cashView(db, cashId) {
  const row = (await record(db, 'cash_sessions', cashId));
  return { ...publicRecord(row), expectedCents: (await cashExpected(db, row)), movements: (await db.prepare('SELECT * FROM cash_movements WHERE cash_session_id=? ORDER BY created_at,id').all(cashId)).map(publicRecord) };
}

export async function stockRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/products\/([\w-]+)\/movements$/u);
  if (!match) return null;
  requireRole(ctx.session, READERS);
  const productId = match[1]; (await record(ctx.db, 'products', productId));
  if (ctx.method === 'GET') {
    const { rows, page } = (await paginate(ctx.db, ctx.url, 'SELECT * FROM stock_movements WHERE product_id=? ORDER BY created_at DESC,id', [productId]));
    return { data: { items: rows.map(publicRecord), page } };
  }
  if (ctx.method === 'POST') return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['version','type','quantityMilli','notes']);
    const product = (await record(ctx.db, 'products', productId, true)); version(product, body.version);
    const type = v.choice(body.type, 'type', ['purchase','adjustment_in','adjustment_out']);
    const amount = quantity(body.quantityMilli, 'quantityMilli', 1);
    const movementId = (await stockChange(ctx.db, { product, amount: type === 'adjustment_out' ? -amount : amount, kind: type, notes: memo(body.notes) }));
    (await changed(ctx, 'product.stock_changed', 'product', productId, { movementId, type, quantityMilli: amount }));
    const item = publicRecord((await record(ctx.db, 'products', productId)));
    return { ...item, lowStock: item.quantityMilli <= item.minQuantityMilli };
  }));
  return null;
}

export async function cashRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/cash(?:\/(current|open|[\w-]+))?(?:\/(movements|close))?$/u);
  if (!match) return null;
  const [, cashId, action] = match;
  requireRole(ctx.session, cashId === 'current' ? OPERATORS : MANAGERS);
  if (ctx.method === 'GET' && !action) {
    if (cashId === 'current') { const current = (await ctx.db.prepare("SELECT id FROM cash_sessions WHERE status='open'").get()); return { data: { item: current ? (await cashView(ctx.db, current.id)) : null } }; }
    if (cashId) return { data: { item: (await cashView(ctx.db, cashId)) } };
    const { rows, page } = (await paginate(ctx.db, ctx.url, 'SELECT id FROM cash_sessions ORDER BY opened_at DESC,id'));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await cashView(ctx.db, row.id))))), page } };
  }
  if (ctx.method === 'POST' && cashId === 'open' && !action) return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['openingCents','notes']);
    assert(!(await ctx.db.prepare("SELECT id FROM cash_sessions WHERE status='open'").get()), 409, 'CASH_ALREADY_OPEN', 'Já existe um caixa aberto.');
    const openingCents = money(body.openingCents, 'openingCents');
    const row = (await insert(ctx.db, 'cash_sessions', { status: 'open', openingCents, countedCents: null, differenceCents: null, notes: memo(body.notes), openedAt: now(), closedAt: null, openedBy: ctx.session.user.id, closedBy: null }));
    (await changed(ctx, 'cash.opened', 'cash', row.id, { openingCents }));
    return (await cashView(ctx.db, row.id));
  }, 201));
  if (ctx.method === 'POST' && action) return (await mutate(ctx, MANAGERS, async (body) => {
    const row = (await record(ctx.db, 'cash_sessions', cashId)); version(row, body.version);
    assert(row.status === 'open', 409, 'CASH_CLOSED', 'O caixa já foi encerrado.');
    if (action === 'movements') {
      v.onlyKeys(body, ['version','type','amountCents','category','notes']);
      const type = v.choice(body.type, 'type', ['in','out']);
      const amount = money(body.amountCents, 'amountCents', 1);
      const category = v.text(body.category, 'category', { min: 1, max: 80 });
      (await cashMovement(ctx.db, { type, amountCents: amount, method: 'cash', source: 'manual', resourceId: cashId, category, notes: memo(body.notes) }));
      (await changed(ctx, 'cash.manual_movement', 'cash', cashId, { type, amountCents: amount }));
    } else {
      v.onlyKeys(body, ['version','countedCents','notes']);
      const counted = money(body.countedCents, 'countedCents');
      const expected = (await cashExpected(ctx.db, row));
      (await update(ctx.db, 'cash_sessions', row, { status: 'closed', countedCents: counted, differenceCents: counted - expected, closedAt: now(), closedBy: ctx.session.user.id, notes: body.notes === undefined ? row.notes : memo(body.notes) }));
      (await changed(ctx, 'cash.closed', 'cash', cashId, { expectedCents: expected, countedCents: counted, differenceCents: counted - expected }));
    }
    return (await cashView(ctx.db, cashId));
  }));
  return null;
}

export async function invoiceView(db, invoiceId) {
  const row = (await record(db, 'invoices', invoiceId));
  const payments = (await db.prepare("SELECT * FROM payments WHERE source='invoice' AND source_id=? ORDER BY created_at,id").all(invoiceId)).map(publicRecord);
  const paidCents = sumSafe(payments.map((payment) => payment.amountCents));
  const orders = (await Promise.all((await db.prepare('SELECT o.id,o.number,i.amount_cents,o.status FROM invoice_orders i JOIN orders o ON o.id=i.order_id WHERE i.invoice_id=? ORDER BY o.number').all(invoiceId)).map(async (order) => ({ ...publicRecord(order), ...(await orderBalance(db, order.id)) }))));
  return { ...publicRecord(row), customerName: (await record(db, 'customers', row.customer_id)).name, paidCents, balanceCents: row.status === 'cancelled' ? 0 : row.total_cents - paidCents, orders, payments };
}

export async function invoiceRoutes(ctx) {
  const match = ctx.pathname.match(/^\/api\/invoices(?:\/([\w-]+))?(?:\/(payments|cancel))?$/u);
  if (!match) return null;
  requireRole(ctx.session, MANAGERS);
  const [, invoiceId, action] = match;
  if (ctx.method === 'GET' && !action) {
    if (invoiceId) return { data: { item: (await invoiceView(ctx.db, invoiceId)) } };
    const clauses = [], params = [];
    const status = ctx.url.searchParams.get('status');
    if (status) { clauses.push('i.status=?'); params.push(v.choice(status, 'status', ['issued','partial','paid','cancelled'])); }
    const customerId = ctx.url.searchParams.get('customerId');
    if (customerId) { clauses.push('i.customer_id=?'); params.push(v.identifier(customerId, 'customerId')); }
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    if (q) { clauses.push('(c.name LIKE ? OR CAST(i.number AS TEXT) LIKE ?)'); params.push(`%${q}%`,`%${q}%`); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT i.id FROM invoices i JOIN customers c ON c.id=i.customer_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY i.created_at DESC,i.number DESC`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await invoiceView(ctx.db, row.id))))), page } };
  }
  if (ctx.method === 'POST' && !invoiceId) return (await mutate(ctx, MANAGERS, async (body) => {
    v.onlyKeys(body, ['customerId','orderIds','dueDate','notes']);
    const customer = (await record(ctx.db, 'customers', v.identifier(body.customerId, 'customerId'), true));
    assert(customer.postpaid, 409, 'POSTPAID_REQUIRED', 'O cliente precisa estar habilitado como pós-pago.');
    assert(Array.isArray(body.orderIds) && body.orderIds.length >= 1 && body.orderIds.length <= 500, 422, 'VALIDATION_ERROR', 'Selecione de 1 a 500 ordens.');
    assert(new Set(body.orderIds).size === body.orderIds.length, 422, 'DUPLICATE_ORDER', 'A seleção contém uma ordem repetida.');
    const entries = (await Promise.all(body.orderIds.map(async (value) => {
      const order = (await record(ctx.db, 'orders', v.identifier(value, 'orderIds')));
      assert(order.customer_id === customer.id && ['ready','delivered'].includes(order.status), 409, 'ORDER_NOT_INVOICEABLE', 'Selecione ordens prontas ou entregues do mesmo cliente.');
      assert(!order.invoice_id, 409, 'ORDER_ALREADY_INVOICED', 'Uma ordem selecionada já pertence a uma fatura.');
      const amountCents = (await orderBalance(ctx.db, order.id)).balanceCents;
      assert(amountCents > 0, 409, 'ORDER_ALREADY_PAID', 'Uma ordem selecionada já está quitada.');
      return { order, amountCents };
    })));
    const total = sumSafe(entries.map((entry) => entry.amountCents)); money(total, 'totalCents', 1);
    const number = (await ctx.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS value FROM invoices').get()).value;
    const invoice = (await insert(ctx.db, 'invoices', { number, customerId: customer.id, status: 'issued', dueDate: v.date(body.dueDate, 'dueDate'), totalCents: total, notes: memo(body.notes) }));
    for (const { order, amountCents } of entries) {
      (await ctx.db.prepare('INSERT INTO invoice_orders(invoice_id,order_id,amount_cents) VALUES(?,?,?)').run(invoice.id, order.id, amountCents));
      (await update(ctx.db, 'orders', order, { invoiceId: invoice.id }));
    }
    (await changed(ctx, 'invoice.created', 'invoice', invoice.id, { totalCents: total, orders: entries.length }));
    return (await invoiceView(ctx.db, invoice.id));
  }, 201));
  if (ctx.method === 'POST' && invoiceId && action) return (await mutate(ctx, MANAGERS, async (body) => {
    const row = (await record(ctx.db, 'invoices', invoiceId)); version(row, body.version);
    assert(!['paid','cancelled'].includes(row.status), 409, 'INVOICE_CLOSED', 'A fatura já foi encerrada.');
    const before = (await invoiceView(ctx.db, invoiceId));
    if (action === 'cancel') {
      v.onlyKeys(body, ['version']);
      assert(before.paidCents === 0, 409, 'INVOICE_HAS_PAYMENTS', 'A fatura tem recebimentos e não pode ser cancelada.');
      for (const order of before.orders) (await touchOrder(ctx.db, order.id, { invoiceId: null }));
      (await update(ctx.db, 'invoices', row, { status: 'cancelled' }));
      (await changed(ctx, 'invoice.cancelled', 'invoice', invoiceId));
    } else {
      v.onlyKeys(body, ['version','amountCents','method','reference']);
      const amount = money(body.amountCents, 'amountCents', 1);
      assert(amount <= before.balanceCents, 409, 'OVERPAYMENT', 'O recebimento excede o saldo da fatura.');
      const method = v.choice(body.method, 'method', METHODS);
      const paymentId = (await receive(ctx.db, { source: 'invoice', sourceId: invoiceId, customerId: row.customer_id, amountCents: amount, method, reference: v.text(body.reference ?? '', 'reference', { max: 120 }) }));
      let remaining = amount;
      for (const order of before.orders) {
        if (!remaining) break;
        const allocation = Math.min(remaining, order.balanceCents);
        if (!allocation) continue;
        (await ctx.db.prepare('INSERT INTO payment_allocations(payment_id,order_id,amount_cents) VALUES(?,?,?)').run(paymentId, order.id, allocation));
        (await touchOrder(ctx.db, order.id));
        remaining -= allocation;
      }
      assert(remaining === 0, 409, 'INVOICE_BALANCE_MISMATCH', 'O saldo das ordens precisa ser conferido antes da baixa.');
      (await update(ctx.db, 'invoices', row, { status: amount === before.balanceCents ? 'paid' : 'partial' }));
      (await changed(ctx, 'invoice.payment_recorded', 'invoice', invoiceId, { amountCents: amount, method, paymentId }));
    }
    return (await invoiceView(ctx.db, invoiceId));
  }));
  return null;
}

export async function packageSaleView(db, saleId) {
  const row = (await record(db, 'package_sales', saleId));
  return { ...publicRecord(row), customerName: (await record(db, 'customers', row.customer_id)).name, expired: row.expires_at <= now() };
}

export async function packageRoutes(ctx) {
  const list = ctx.pathname.match(/^\/api\/package-sales(?:\/([\w-]+))?$/u);
  if (list && ctx.method === 'GET') {
    requireRole(ctx.session, READERS);
    if (list[1]) return { data: { item: (await packageSaleView(ctx.db, list[1])) } };
    const clauses = [], params = [];
    if (ctx.url.searchParams.has('customerId')) { clauses.push('s.customer_id=?'); params.push(v.identifier(ctx.url.searchParams.get('customerId'), 'customerId')); }
    const q = v.text(ctx.url.searchParams.get('q') || '', 'q', { max: 120 });
    if (q) { clauses.push('(s.package_name LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT s.id FROM package_sales s JOIN customers c ON c.id=s.customer_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY s.created_at DESC,s.id`, params));
    return { data: { items: (await Promise.all(rows.map(async (row) => (await packageSaleView(ctx.db, row.id))))), page } };
  }
  const sale = ctx.pathname.match(/^\/api\/packages\/([\w-]+)\/sales$/u);
  if (sale && ctx.method === 'POST') return (await mutate(ctx, OPERATORS, async (body) => {
    v.onlyKeys(body, ['customerId','method','reference']);
    const plan = (await record(ctx.db, 'packages', sale[1], true));
    const customer = (await record(ctx.db, 'customers', v.identifier(body.customerId, 'customerId'), true));
    const service = (await record(ctx.db, 'services', plan.service_id, true));
    const method = v.choice(body.method, 'method', METHODS);
    const row = (await insert(ctx.db, 'package_sales', { packageId: plan.id, customerId: customer.id, serviceId: service.id, packageName: plan.name, serviceName: service.name, credits: plan.credits, remainingCredits: plan.credits, priceCents: plan.price_cents, expiresAt: new Date(Date.now() + plan.valid_days * 86400_000).toISOString(), paymentId: null }));
    const paymentId = (await receive(ctx.db, { source: 'package', sourceId: row.id, customerId: customer.id, amountCents: plan.price_cents, method, reference: v.text(body.reference ?? '', 'reference', { max: 120 }) }));
    (await ctx.db.prepare('UPDATE package_sales SET payment_id=? WHERE id=?').run(paymentId, row.id));
    (await changed(ctx, 'package.sold', 'package_sale', row.id, { packageId: plan.id, priceCents: plan.price_cents, credits: plan.credits, method }));
    return (await packageSaleView(ctx.db, row.id));
  }, 201));
  const redemption = ctx.pathname.match(/^\/api\/orders\/([\w-]+)\/package-redemptions(?:\/([\w-]+)\/reverse)?$/u);
  if (redemption && ctx.method === 'POST') return (await mutate(ctx, OPERATORS, async (body) => {
    const orderId = redemption[1], redemptionId = redemption[2];
    const order = (await record(ctx.db, 'orders', orderId)); version(order, body.version);
    assert(!['quote','delivered','cancelled'].includes(order.status) && !order.invoice_id, 409, 'ORDER_NOT_REDEEMABLE', 'Esta ordem não permite alteração de créditos.');
    if (redemptionId) {
      v.onlyKeys(body, ['version']);
      const redeemed = (await record(ctx.db, 'package_redemptions', redemptionId));
      assert(redeemed.order_id === orderId, 422, 'INVALID_REDEMPTION', 'O resgate não pertence à ordem.');
      assert(!redeemed.reversed, 409, 'ALREADY_REVERSED', 'O resgate já foi revertido.');
      const purchased = (await record(ctx.db, 'package_sales', redeemed.package_sale_id));
      (await update(ctx.db, 'package_sales', purchased, { remainingCredits: purchased.remaining_credits + redeemed.quantity }));
      (await ctx.db.prepare('UPDATE package_redemptions SET reversed=1,reversed_at=? WHERE id=?').run(now(), redemptionId));
      (await changed(ctx, 'package.redemption_reversed', 'order', orderId, { redemptionId, quantity: redeemed.quantity }));
    } else {
      v.onlyKeys(body, ['version','packageSaleId','quantity']);
      const purchased = (await record(ctx.db, 'package_sales', v.identifier(body.packageSaleId, 'packageSaleId')));
      const count = v.integer(body.quantity, 'quantity', { min: 1, max: 1000 });
      assert(purchased.customer_id === order.customer_id, 422, 'PACKAGE_CUSTOMER_MISMATCH', 'O pacote não pertence ao cliente da ordem.');
      assert(purchased.expires_at > now(), 409, 'PACKAGE_EXPIRED', 'Os créditos do pacote expiraram.');
      assert(purchased.remaining_credits >= count, 409, 'INSUFFICIENT_CREDITS', 'O pacote não tem créditos suficientes.');
      const line = (await ctx.db.prepare('SELECT * FROM order_items WHERE order_id=? AND service_id=?').get(orderId, purchased.service_id));
      assert(line, 422, 'PACKAGE_SERVICE_MISMATCH', 'A ordem não contém o serviço deste pacote.');
      const applied = (await ctx.db.prepare('SELECT COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(amount_cents),0) AS amount FROM package_redemptions WHERE order_id=? AND service_id=? AND reversed=0').get(orderId, purchased.service_id));
      const used = applied.quantity;
      assert(used + count <= line.quantity, 409, 'CREDITS_EXCEED_QUANTITY', 'O resgate excede a quantidade de serviços da ordem.');
      // Allocate against the remaining cents and service units. Reversing an earlier
      // redemption cannot strand a rounding cent or make the final unit overpay.
      const covered = floorRatio(line.net_cents - applied.amount, count, line.quantity - used);
      assert(covered <= (await orderBalance(ctx.db, orderId)).balanceCents, 409, 'OVERPAYMENT', 'O crédito excede o saldo da ordem.');
      const redemptionId = id();
      (await ctx.db.prepare('INSERT INTO package_redemptions(id,order_id,package_sale_id,service_id,quantity,amount_cents,created_at) VALUES(?,?,?,?,?,?,?)').run(redemptionId, orderId, purchased.id, purchased.service_id, count, covered, now()));
      (await update(ctx.db, 'package_sales', purchased, { remainingCredits: purchased.remaining_credits - count }));
      (await changed(ctx, 'package.redeemed', 'order', orderId, { redemptionId, quantity: count, amountCents: covered }));
    }
    (await touchOrder(ctx.db, orderId));
    return (await orderView(ctx.db, orderId));
  }));
  return null;
}

export async function paymentRoutes(ctx) {
  if (ctx.pathname !== '/api/payments' || ctx.method !== 'GET') return null;
  requireRole(ctx.session, MANAGERS);
  const clauses = [], params = [];
  if (ctx.url.searchParams.has('customerId')) { clauses.push('p.customer_id=?'); params.push(v.identifier(ctx.url.searchParams.get('customerId'), 'customerId')); }
  if (ctx.url.searchParams.has('source')) { clauses.push('p.source=?'); params.push(v.choice(ctx.url.searchParams.get('source'), 'source', ['order','invoice','package'])); }
  const { rows, page } = (await paginate(ctx.db, ctx.url, `SELECT p.*,c.name AS customer_name FROM payments p JOIN customers c ON c.id=p.customer_id${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY p.created_at DESC,p.id`, params));
  return { data: { items: rows.map(publicRecord), page } };
}
