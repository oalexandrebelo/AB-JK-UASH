import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FISCAL_FIELDS, IBS_CBS_FIELDS, REQUIRED_FISCAL_FIELDS } from '../integrations/fiscal/payload.mjs';
import { FISCAL_STATUSES, FISCAL_SCHEMA_VERSION } from '../integrations/fiscal/index.mjs';

// Contract reviewed against application.mjs, domain-*.mjs and media.mjs.
// This file is authoring input; neither the SDK nor server imports it at runtime.
export const schemas = {};
const S = schemas;
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (maxLength, minLength = 0, extra = {}) => ({ type: 'string', ...(maxLength ? { maxLength } : {}), ...(minLength ? { minLength } : {}), ...extra });
const int = (minimum = 0, maximum = 1_000_000_000) => ({ type: 'integer', minimum, maximum });
const bool = { type: 'boolean' };
const en = (...values) => ({ type: 'string', enum: values });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const date = str(undefined, 0, { format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const datetime = str(undefined, 0, { format: 'date-time' });
const identifier = str(100, 1, { pattern: '^[a-zA-Z0-9_-]+$' });
const memo = str(2000);
const cents = int();
const aggregateCents = int(0, Number.MAX_SAFE_INTEGER);
const version = int(1, 100_000_000_000);
const common = { id: identifier, version, createdAt: datetime, updatedAt: datetime };
const managerField = (schema) => ({ ...schema, 'x-visible-to-roles': ['admin', 'manager'] });
const readRoles = ['admin', 'manager', 'operator', 'viewer'];
const operatorRoles = ['admin', 'manager', 'operator'];
const managerRoles = ['admin', 'manager'];
const adminRoles = ['admin'];
const moneyMethods = en('cash', 'pix', 'credit', 'debit', 'transfer');
const orderStatus = en('quote', 'scheduled', 'waiting', 'in_progress', 'quality_check', 'ready', 'delivered', 'cancelled');
const appointmentStatus = en('scheduled', 'confirmed', 'arrived', 'converted', 'cancelled');
const notes = { notes: memo };
const quantity = int(1, 1000);
const entry = (schema) => obj({ item: schema });
const paged = (schema) => obj({ items: arr(schema), page: ref('Page') });
const list = (schema) => obj({ items: arr(schema) });
const bodyPatch = (properties, mandatory = ['version']) => obj({ version, ...properties }, mandatory);
const inputDate = nullable(str(40, 0, { description: 'ISO 8601 com fuso explícito; null ou texto vazio remove a data opcional.' }));
S.Role = en(...readRoles);
S.PaymentMethod = moneyMethods;
S.OrderStatus = orderStatus;
S.AppointmentStatus = appointmentStatus;
S.Page = obj({ limit: int(1, 500), offset: int(), total: int(0, Number.MAX_SAFE_INTEGER), hasMore: bool });
S.Error = obj({ code: str(), message: str(), requestId: str(), details: {} }, ['code', 'message', 'requestId']);
S.ErrorEnvelope = obj({ ok: { const: false, type: 'boolean' }, error: ref('Error') });
S.User = obj({ id: identifier, name: str(80, 2), email: str(254, 3, { format: 'email' }), role: ref('Role'), active: bool, createdAt: datetime });
S.Session = obj({
  setupRequired: bool, setupTokenRequired: bool, storageMode: en('local', 'postgres'),
  user: nullable(ref('User')), csrfToken: str(43, 43), expiresAt: datetime,
}, ['setupRequired', 'setupTokenRequired', 'storageMode', 'user']);
S.AuthenticatedSession = obj({ setupRequired: { const: false, type: 'boolean' }, setupTokenRequired: bool, storageMode: en('local', 'postgres'), user: ref('User'), csrfToken: str(43, 43), expiresAt: datetime });
S.PasswordSession = obj({ setupTokenRequired: bool, storageMode: en('local', 'postgres'), user: ref('User'), csrfToken: str(43, 43), expiresAt: datetime });
S.SetupInput = obj({ name: str(80, 2), email: str(254, 3, { format: 'email' }), password: str(128, 12, { writeOnly: true }) });
S.LoginInput = obj({ email: str(254, 3, { format: 'email' }), password: str(128, 1, { writeOnly: true }) });
S.ChangePasswordInput = obj({ currentPassword: str(128, 1, { writeOnly: true }), newPassword: str(128, 12, { writeOnly: true }) });
S.CreateUserInput = obj({ ...S.SetupInput.properties, role: ref('Role') });
S.UpdateUserInput = obj({ name: str(80, 2), role: ref('Role'), active: bool }, [], { minProperties: 1 });
S.AuditEvent = obj({ id: identifier, actorId: nullable(identifier), action: str(), resourceType: str(), resourceId: nullable(str()), metadata: { type: 'object', additionalProperties: true }, createdAt: datetime });

const masters = {
  Customer: {
    path: 'customers', roles: operatorRoles,
    properties: { name: str(120, 2), phone: str(30), email: { anyOf: [str(254, 3, { format: 'email' }), { const: '' }] }, kind: en('individual', 'company'), postpaid: bool, notes: memo, active: bool },
    required: ['name'], decoration: {},
  },
  Vehicle: {
    path: 'vehicles', roles: operatorRoles,
    properties: { customerId: identifier, plate: str(16, 4, { description: 'Letras e números; espaços e hífens são removidos, letras convertidas a maiúsculas.' }), model: str(100, 1), color: str(60), category: en('small', 'medium', 'large', 'motorcycle'), active: bool },
    required: ['customerId', 'plate', 'model'], decoration: { customerName: str() },
  },
  Service: {
    path: 'services', roles: managerRoles,
    properties: { name: str(120, 2), priceCents: cents, durationMinutes: int(1, 1440), commissionBps: int(0, 10000), active: bool },
    required: ['name', 'priceCents'], decoration: {},
  },
  Employee: {
    path: 'employees', roles: managerRoles,
    properties: { name: str(120, 2), roleLabel: str(80), baseSalaryCents: cents, commissionBps: int(0, 10000), active: bool },
    required: ['name'], decoration: {},
  },
  Product: {
    path: 'products', roles: managerRoles,
    properties: { name: str(120, 2), sku: str(60, 1), unit: str(16, 1), quantityMilli: int(), minQuantityMilli: int(), costCents: cents, active: bool },
    required: ['name', 'sku'], decoration: { lowStock: bool },
  },
  Package: {
    path: 'packages', roles: managerRoles,
    properties: { name: str(120, 2), serviceId: identifier, credits: int(1, 10000), priceCents: int(1), validDays: int(1, 3650), active: bool },
    required: ['name', 'serviceId', 'credits', 'priceCents'], decoration: { serviceName: str() },
  },
};
for (const [name, spec] of Object.entries(masters)) {
  S[name] = obj({ ...common, ...spec.properties, ...spec.decoration });
  S[`Create${name}Input`] = obj(spec.properties, spec.required);
  const updateProperties = { ...spec.properties };
  if (name === 'Product') delete updateProperties.quantityMilli;
  S[`Update${name}Input`] = bodyPatch(updateProperties);
}
S.Employee.properties.baseSalaryCents = managerField(cents);
S.Employee.properties.commissionBps = managerField(int(0, 10000));
S.Employee.required = S.Employee.required.filter((key) => !['baseSalaryCents', 'commissionBps'].includes(key));
S.ServiceSelection = obj({ serviceId: identifier, quantity });
S.ChecklistItem = obj({ zone: str(100, 1), condition: en('ok', 'attention', 'damage', 'not_applicable'), notes: memo });
S.ChecklistInputItem = obj(S.ChecklistItem.properties, ['zone', 'condition']);
S.OrderItem = obj({
  id: identifier, orderId: identifier, serviceId: identifier, name: str(), quantity, position: int(),
  unitPriceCents: cents, durationMinutes: int(1, 1440), commissionBps: int(0, 10000),
  lineTotalCents: cents, discountCents: cents, netCents: cents, commissionCents: cents,
});
S.StockMovement = obj({ id: identifier, productId: identifier, orderId: nullable(identifier), kind: en('opening', 'purchase', 'adjustment_in', 'adjustment_out', 'consumption', 'reversal'), quantityMilli: int(-1_000_000_000), reverseOf: nullable(identifier), notes: memo, createdAt: datetime });
S.Consumption = obj({ ...S.StockMovement.properties, productName: str(), reversed: bool });
S.Payment = obj({ id: identifier, source: en('order', 'invoice', 'package'), sourceId: identifier, customerId: identifier, amountCents: int(1), method: moneyMethods, reference: str(120), createdAt: datetime });
S.PaymentListItem = obj({ ...S.Payment.properties, customerName: str() });
S.OrderPayment = obj({ id: identifier, amountCents: int(1), method: moneyMethods, reference: str(120), source: en('order', 'invoice', 'package'), createdAt: datetime });
S.PackageRedemption = obj({ id: identifier, orderId: identifier, packageSaleId: identifier, serviceId: identifier, quantity, amountCents: cents, reversed: bool, createdAt: datetime, reversedAt: nullable(datetime), packageName: str() });
S.Order = obj({
  ...common, number: int(1, Number.MAX_SAFE_INTEGER), customerId: identifier, vehicleId: identifier, employeeId: nullable(identifier), status: orderStatus,
  subtotalCents: cents, discountCents: cents, totalCents: cents, scheduledAt: nullable(datetime), promisedAt: nullable(datetime), notes: memo,
  invoiceId: nullable(identifier), deliveredAt: nullable(datetime), settledAt: nullable(datetime),
  paidCents: cents, creditCents: cents, balanceCents: cents, customerName: str(), customerPostpaid: bool, vehiclePlate: str(), vehicleModel: str(), employeeName: str(),
  items: arr(ref('OrderItem')), checklist: arr(ref('ChecklistItem')), payments: arr(ref('OrderPayment')), consumptions: arr(ref('Consumption')), packageRedemptions: arr(ref('PackageRedemption')),
});
const orderInput = { customerId: identifier, vehicleId: identifier, employeeId: nullable(identifier), items: arr(ref('ServiceSelection'), { minItems: 1, maxItems: 100 }), discountCents: cents, status: en('quote', 'scheduled', 'waiting'), scheduledAt: inputDate, promisedAt: inputDate, notes: memo };
S.CreateOrderInput = obj(orderInput, ['customerId', 'vehicleId', 'items']);
S.UpdateOrderInput = bodyPatch(orderInput);
S.VersionInput = obj({ version });
S.TransitionOrderInput = obj({ version, status: orderStatus });
S.RecordPaymentInput = obj({ version, amountCents: int(1), method: moneyMethods, reference: str(120) }, ['version', 'amountCents', 'method']);
S.UpdateChecklistInput = obj({ version, items: arr(ref('ChecklistInputItem'), { maxItems: 100 }) });
S.ConsumeProductInput = obj({ version, productId: identifier, quantityMilli: int(1), notes: memo }, ['version', 'productId', 'quantityMilli']);
S.ReverseConsumptionInput = obj({ version, notes: memo }, ['version']);
S.RedeemPackageInput = obj({ version, packageSaleId: identifier, quantity });
S.Photo = obj({ id: identifier, orderId: identifier, mimeType: en('image/jpeg', 'image/png'), bytes: int(20, 1572864), caption: str(500), version, createdAt: datetime, updatedAt: datetime });
S.PhotoContent = obj({ ...S.Photo.properties, dataUri: str(undefined, 1, { pattern: '^data:image/(jpeg|png);base64,' }) });
S.AddPhotoInput = obj({ mimeType: en('image/jpeg', 'image/png'), dataBase64: str(2097152, 1, { contentEncoding: 'base64', description: 'JPEG ou PNG até 1,5 MiB e 16 megapixels; máximo oito fotos por ordem.' }), caption: nullable(str(500)) }, ['mimeType', 'dataBase64']);
S.UpdatePhotoInput = obj({ version, caption: str(500) });
S.Appointment = obj({ ...common, customerId: identifier, vehicleId: identifier, employeeId: nullable(identifier), startsAt: datetime, endsAt: datetime, status: appointmentStatus, orderId: nullable(identifier), notes: memo, items: arr(ref('ServiceSelection')), customerName: str(), vehiclePlate: str(), employeeName: str() });
const appointmentInput = { customerId: identifier, vehicleId: identifier, employeeId: nullable(identifier), items: arr(ref('ServiceSelection'), { minItems: 1, maxItems: 100 }), startsAt: datetime, endsAt: inputDate, notes: memo, status: en('scheduled', 'confirmed', 'arrived', 'cancelled') };
S.CreateAppointmentInput = obj(appointmentInput, ['customerId', 'vehicleId', 'items', 'startsAt']);
S.UpdateAppointmentInput = bodyPatch(appointmentInput);
S.ChangeStockInput = obj({ version, type: en('purchase', 'adjustment_in', 'adjustment_out'), quantityMilli: int(1), notes: memo }, ['version', 'type', 'quantityMilli']);
S.CashMovement = obj({ id: identifier, cashSessionId: nullable(identifier), type: en('in', 'out'), amountCents: int(1), method: moneyMethods, source: str(), resourceId: nullable(str()), category: str(80), notes: memo, createdAt: datetime });
S.CashSession = obj({ ...common, status: en('open', 'closed'), openingCents: cents, countedCents: nullable(cents), differenceCents: nullable(int(-1_000_000_000)), notes: memo, openedAt: datetime, closedAt: nullable(datetime), openedBy: identifier, closedBy: nullable(identifier), expectedCents: cents, movements: arr(ref('CashMovement')) });
S.OpenCashInput = obj({ openingCents: cents, notes: memo }, ['openingCents']);
S.MoveCashInput = obj({ version, type: en('in', 'out'), amountCents: int(1), category: str(80, 1), notes: memo }, ['version', 'type', 'amountCents', 'category']);
S.CloseCashInput = obj({ version, countedCents: cents, notes: memo }, ['version', 'countedCents']);
S.InvoiceOrder = obj({ id: identifier, number: int(1, Number.MAX_SAFE_INTEGER), amountCents: int(1), status: orderStatus, paidCents: cents, creditCents: cents, balanceCents: cents });
S.Invoice = obj({ ...common, number: int(1, Number.MAX_SAFE_INTEGER), customerId: identifier, status: en('issued', 'partial', 'paid', 'cancelled'), dueDate: date, totalCents: int(1), notes: memo, customerName: str(), paidCents: cents, balanceCents: cents, orders: arr(ref('InvoiceOrder')), payments: arr(ref('Payment')) });
S.CreateInvoiceInput = obj({ customerId: identifier, orderIds: arr(identifier, { minItems: 1, maxItems: 500, uniqueItems: true }), dueDate: date, notes: memo }, ['customerId', 'orderIds', 'dueDate']);
S.PackageSale = obj({ ...common, packageId: identifier, customerId: identifier, serviceId: identifier, packageName: str(), serviceName: str(), credits: int(1, 10000), remainingCredits: int(0, 10000), priceCents: int(1), expiresAt: datetime, paymentId: nullable(identifier), customerName: str(), expired: bool });
S.SellPackageInput = obj({ customerId: identifier, method: moneyMethods, reference: str(120) }, ['customerId', 'method']);
S.PayrollAdjustment = obj({ employeeId: identifier, extrasCents: cents, deductionsCents: cents }, ['employeeId']);
S.PayrollLine = obj({ id: identifier, payrollId: identifier, employeeId: identifier, employeeName: str(), baseCents: cents, commissionCents: aggregateCents, extrasCents: cents, deductionsCents: cents, totalCents: cents, orderIds: arr(identifier) });
S.Payroll = obj({ ...common, period: str(7, 7, { pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }), status: en('draft', 'approved', 'paid'), notes: memo, paidAt: nullable(datetime), paymentMethod: nullable(moneyMethods), lines: arr(ref('PayrollLine')), baseCents: aggregateCents, commissionCents: aggregateCents, extrasCents: aggregateCents, deductionsCents: aggregateCents, totalCents: cents });
S.CreatePayrollInput = obj({ period: S.Payroll.properties.period, adjustments: arr(ref('PayrollAdjustment'), { maxItems: 500 }), notes: memo }, ['period']);
S.UpdatePayrollInput = bodyPatch({ adjustments: arr(ref('PayrollAdjustment'), { maxItems: 500 }), notes: memo });
S.PayPayrollInput = obj({ version, method: moneyMethods });
S.Message = obj({ ...common, customerId: identifier, template: en('custom', 'after_service', 'appointment'), body: str(4000, 1), status: en('draft', 'queued', 'cancelled'), orderId: nullable(identifier), appointmentId: nullable(identifier), customerName: str(), channel: { const: 'whatsapp' }, deliveryMode: { const: 'local_only' }, sentAt: { type: 'null' } });
S.CreateMessageInput = obj({ customerId: identifier, template: en('custom', 'after_service', 'appointment'), body: str(4000, 1), orderId: nullable(identifier), appointmentId: nullable(identifier) }, ['customerId'], { description: 'body obrigatório quando template ausente/custom; templates after_service e appointment geram texto quando body é omitido. A fila é exclusivamente local; esta API não envia mensagens.' });
S.UpdateMessageInput = obj({ version, body: str(4000, 1) });
S.Settings = obj({ businessName: str(120, 2), phone: str(30), address: str(300), currency: { const: 'BRL' }, timezone: { const: 'America/Sao_Paulo' }, receiptFooter: str(1000), version });
S.UpdateSettingsInput = bodyPatch({ businessName: str(120, 2), phone: str(30), address: str(300), receiptFooter: str(1000) }, ['version']);
S.Dashboard = obj({
  businessDate: date, timezone: str(), ordersByStatus: obj(Object.fromEntries(orderStatus.enum.map((s) => [s, int(0, Number.MAX_SAFE_INTEGER)]))),
  openOrders: int(0, Number.MAX_SAFE_INTEGER), lowStockCount: int(0, Number.MAX_SAFE_INTEGER), appointmentsToday: int(0, Number.MAX_SAFE_INTEGER),
  recentOrders: arr(ref('Order')), upcomingAppointments: arr(ref('Appointment')), stockAlerts: arr(ref('Product')),
  receivedTodayCents: managerField(int(0, Number.MAX_SAFE_INTEGER)), receivableCents: managerField(int(0, Number.MAX_SAFE_INTEGER)),
}, ['businessDate', 'timezone', 'ordersByStatus', 'openOrders', 'lowStockCount', 'appointmentsToday', 'recentOrders', 'upcomingAppointments', 'stockAlerts']);
S.ReportSummary = obj({ receivedCents: int(0, Number.MAX_SAFE_INTEGER), deliveredCents: int(0, Number.MAX_SAFE_INTEGER), openReceivableCents: int(0, Number.MAX_SAFE_INTEGER), orderCount: int(0, Number.MAX_SAFE_INTEGER) });
S.SummaryReportRow = obj({ id: en('received', 'delivered', 'receivable', 'orders'), metric: en('receivedCents', 'deliveredCents', 'openReceivableCents', 'orderCount'), label: str(), value: int(0, Number.MAX_SAFE_INTEGER), unit: en('cents', 'count') });
S.SalesReportRow = obj({ id: identifier, createdAt: datetime, source: en('order', 'invoice', 'package'), customerName: str(), method: moneyMethods, amountCents: int(1), reference: str(120) });
S.ServicesReportRow = obj({ id: identifier, serviceId: identifier, name: str(), quantity: int(0, Number.MAX_SAFE_INTEGER), grossCents: int(0, Number.MAX_SAFE_INTEGER), netCents: int(0, Number.MAX_SAFE_INTEGER), commissionCents: int(0, Number.MAX_SAFE_INTEGER) });
S.EmployeesReportRow = obj({ id: identifier, employeeId: identifier, name: str(), orders: int(0, Number.MAX_SAFE_INTEGER), netCents: int(0, Number.MAX_SAFE_INTEGER), commissionCents: int(0, Number.MAX_SAFE_INTEGER) });
S.StockReportRow = obj({ id: identifier, name: str(), sku: str(), unit: str(), quantityMilli: int(), minQuantityMilli: int(), costCents: cents, lowStock: bool });
S.CashReportRow = obj({ id: identifier, cashSessionId: nullable(identifier), createdAt: datetime, type: en('in', 'out'), source: str(), method: moneyMethods, amountCents: int(1), category: str() });
S.Report = { oneOf: ['Summary', 'Sales', 'Services', 'Employees', 'Stock', 'Cash'].map((name) => obj({
  items: arr(ref(`${name}ReportRow`)), page: ref('Page'), summary: ref('ReportSummary'),
  period: obj({ from: date, to: date, timezone: str() }), type: { const: name.toLowerCase() }, positionAsOf: datetime,
})) };

const pageQuery = { limit: { ...int(1, 500), default: 200 }, offset: { ...int(), default: 0 } };
const searchQuery = { ...pageQuery, q: str(120) };
export const operations = [];
function op(operationId, method, path, { response, body, query, roles = readRoles, protectedWrite = method !== 'GET', status = 200, additionalStatuses = [], description = '', tags, setupToken = false } = {}) {
  const pathNames = Array.from(path.matchAll(/\{(\w+)\}/g), (m) => m[1]);
  const entry = { operationId, method, path, roles, protectedWrite, status, additionalStatuses, description, tags: tags || [path.split('/')[2]], setupToken };
  if (body) entry.body = body;
  if (query) entry.query = query;
  if (pathNames.length) entry.pathParams = Object.fromEntries(pathNames.map((name) => [name, identifier]));
  entry.response = response;
  operations.push(entry);
}
op('getHealth', 'GET', '/api/health', { roles: [], response: obj({ status: { const: 'ok' } }) });
op('getStatus', 'GET', '/api/status', { roles: [], response: ref('Session') });
op('getSession', 'GET', '/api/auth/session', { roles: [], response: ref('Session') });
op('setup', 'POST', '/api/setup', { roles: [], body: ref('SetupInput'), response: ref('AuthenticatedSession'), status: 201, protectedWrite: false, setupToken: true, description: 'Cria o primeiro administrador e inicia a sessão. Em ambiente configurado com setupToken, exige X-Setup-Token. Não repetir automaticamente.' });
op('login', 'POST', '/api/auth/login', { roles: [], body: ref('LoginInput'), response: ref('AuthenticatedSession'), protectedWrite: false });
op('logout', 'POST', '/api/auth/logout', { body: { type: 'object', additionalProperties: true }, response: obj({ loggedOut: { const: true }, storageMode: en('local', 'postgres'), setupTokenRequired: { const: false } }), protectedWrite: false });
op('changePassword', 'POST', '/api/auth/password', { body: ref('ChangePasswordInput'), response: ref('PasswordSession'), protectedWrite: false, description: 'Troca a senha, revoga as sessões anteriores e entrega uma nova sessão.' });
op('listUsers', 'GET', '/api/users', { roles: adminRoles, response: list(ref('User')), description: 'Sem paginação. O retorno contém items.' });
op('createUser', 'POST', '/api/users', { roles: adminRoles, body: ref('CreateUserInput'), response: obj({ user: ref('User') }), status: 201, protectedWrite: false });
op('updateUser', 'PATCH', '/api/users/{userId}', { roles: adminRoles, body: ref('UpdateUserInput'), response: obj({ user: ref('User') }), protectedWrite: false, description: 'Não recebe version nem Idempotency-Key. Mudança de papel ou desativação revoga as sessões.' });
op('listAudit', 'GET', '/api/audit', { roles: managerRoles, query: { limit: { ...int(1, 500), default: 100 } }, response: list(ref('AuditEvent')), description: 'Lista limitada; não contém page e não aceita offset como paginação.' });
for (const [name, spec] of Object.entries(masters)) {
  const path = `/api/${spec.path}`;
  const query = { ...searchQuery, active: en('true', 'false'), ...(name === 'Customer' ? { postpaid: en('true', 'false') } : {}), ...(name === 'Vehicle' ? { customerId: str() } : {}) };
  op(`list${name === 'Person' ? 'People' : name + 's'}`, 'GET', path, { response: paged(ref(name)), query });
  op(`get${name}`, 'GET', `${path}/{id}`, { response: entry(ref(name)) });
  op(`create${name}`, 'POST', path, { roles: spec.roles, body: ref(`Create${name}Input`), response: entry(ref(name)), status: 201 });
  op(`update${name}`, 'PATCH', `${path}/{id}`, { roles: spec.roles, body: ref(`Update${name}Input`), response: entry(ref(name)) });
}
op('listOrders', 'GET', '/api/orders', { response: paged(ref('Order')), query: { ...searchQuery, status: orderStatus, customerId: identifier, vehicleId: identifier, employeeId: identifier } });
op('getOrder', 'GET', '/api/orders/{orderId}', { response: entry(ref('Order')) });
op('createOrder', 'POST', '/api/orders', { roles: operatorRoles, body: ref('CreateOrderInput'), response: entry(ref('Order')), status: 201 });
op('updateOrder', 'PATCH', '/api/orders/{orderId}', { roles: operatorRoles, body: ref('UpdateOrderInput'), response: entry(ref('Order')) });
for (const [id, action, body] of [['transitionOrder', 'transition', 'TransitionOrderInput'], ['recordOrderPayment', 'payments', 'RecordPaymentInput'], ['updateOrderChecklist', 'checklist', 'UpdateChecklistInput'], ['consumeProduct', 'consumptions', 'ConsumeProductInput'], ['reverseConsumption', 'consumptions/{movementId}/reverse', 'ReverseConsumptionInput'], ['redeemPackage', 'package-redemptions', 'RedeemPackageInput'], ['reverseRedemption', 'package-redemptions/{redemptionId}/reverse', 'VersionInput']]) {
  op(id, 'POST', `/api/orders/{orderId}/${action}`, { roles: operatorRoles, body: ref(body), response: entry(ref('Order')) });
}
op('listOrderPhotos', 'GET', '/api/orders/{orderId}/photos', { response: list(ref('Photo')), description: 'Sem paginação; máximo oito fotos.' });
op('getPhoto', 'GET', '/api/order-photos/{photoId}', { response: entry(ref('PhotoContent')) });
const photoResponse = obj({ item: ref('Photo'), replayed: bool }, ['item']);
op('addOrderPhoto', 'POST', '/api/orders/{orderId}/photos', { roles: operatorRoles, body: ref('AddPhotoInput'), response: photoResponse, status: 201, description: 'Na repetição idempotente, data.replayed=true. Corpo JSON até 2.200.000 bytes.' });
op('updatePhoto', 'PATCH', '/api/order-photos/{photoId}', { roles: operatorRoles, body: ref('UpdatePhotoInput'), response: photoResponse, description: 'Na repetição idempotente, data.replayed=true.' });
op('listProductMovements', 'GET', '/api/products/{productId}/movements', { response: paged(ref('StockMovement')), query: pageQuery });
op('changeStock', 'POST', '/api/products/{productId}/movements', { roles: managerRoles, body: ref('ChangeStockInput'), response: entry(ref('Product')) });
op('listCashSessions', 'GET', '/api/cash', { roles: managerRoles, query: pageQuery, response: paged(ref('CashSession')) });
op('getCurrentCash', 'GET', '/api/cash/current', { roles: operatorRoles, response: entry(nullable(ref('CashSession'))) });
op('getCashSession', 'GET', '/api/cash/{cashId}', { roles: managerRoles, response: entry(ref('CashSession')) });
op('openCash', 'POST', '/api/cash/open', { roles: managerRoles, body: ref('OpenCashInput'), response: entry(ref('CashSession')), status: 201 });
op('moveCash', 'POST', '/api/cash/{cashId}/movements', { roles: managerRoles, body: ref('MoveCashInput'), response: entry(ref('CashSession')) });
op('closeCash', 'POST', '/api/cash/{cashId}/close', { roles: managerRoles, body: ref('CloseCashInput'), response: entry(ref('CashSession')) });
op('listInvoices', 'GET', '/api/invoices', { roles: managerRoles, query: { ...searchQuery, status: en('issued', 'partial', 'paid', 'cancelled'), customerId: identifier }, response: paged(ref('Invoice')) });
op('getInvoice', 'GET', '/api/invoices/{invoiceId}', { roles: managerRoles, response: entry(ref('Invoice')) });
op('createInvoice', 'POST', '/api/invoices', { roles: managerRoles, body: ref('CreateInvoiceInput'), response: entry(ref('Invoice')), status: 201 });
op('recordInvoicePayment', 'POST', '/api/invoices/{invoiceId}/payments', { roles: managerRoles, body: ref('RecordPaymentInput'), response: entry(ref('Invoice')) });
op('cancelInvoice', 'POST', '/api/invoices/{invoiceId}/cancel', { roles: managerRoles, body: ref('VersionInput'), response: entry(ref('Invoice')) });
op('listPackageSales', 'GET', '/api/package-sales', { query: { ...searchQuery, customerId: identifier }, response: paged(ref('PackageSale')) });
op('getPackageSale', 'GET', '/api/package-sales/{saleId}', { response: entry(ref('PackageSale')) });
op('sellPackage', 'POST', '/api/packages/{packageId}/sales', { roles: operatorRoles, body: ref('SellPackageInput'), response: entry(ref('PackageSale')), status: 201 });
op('listPayments', 'GET', '/api/payments', { roles: managerRoles, query: { ...pageQuery, customerId: identifier, source: en('order', 'invoice', 'package') }, response: paged(ref('PaymentListItem')) });
op('listPayroll', 'GET', '/api/payroll', { roles: managerRoles, query: { ...pageQuery, status: en('draft', 'approved', 'paid') }, response: paged(ref('Payroll')) });
op('getPayroll', 'GET', '/api/payroll/{payrollId}', { roles: managerRoles, response: entry(ref('Payroll')) });
op('createPayroll', 'POST', '/api/payroll', { roles: managerRoles, body: ref('CreatePayrollInput'), response: entry(ref('Payroll')), status: 201 });
op('updatePayroll', 'PATCH', '/api/payroll/{payrollId}', { roles: managerRoles, body: ref('UpdatePayrollInput'), response: entry(ref('Payroll')) });
for (const [id, action, body] of [['approvePayroll', 'approve', 'VersionInput'], ['payPayroll', 'pay', 'PayPayrollInput'], ['recalculatePayroll', 'recalculate', 'VersionInput']]) {
  op(id, 'POST', `/api/payroll/{payrollId}/${action}`, { roles: managerRoles, body: ref(body), response: entry(ref('Payroll')) });
}
op('listAppointments', 'GET', '/api/appointments', { response: paged(ref('Appointment')), query: { ...searchQuery, status: appointmentStatus, customerId: identifier, employeeId: identifier } });
op('getAppointment', 'GET', '/api/appointments/{appointmentId}', { response: entry(ref('Appointment')) });
op('createAppointment', 'POST', '/api/appointments', { roles: operatorRoles, body: ref('CreateAppointmentInput'), response: entry(ref('Appointment')), status: 201 });
op('updateAppointment', 'PATCH', '/api/appointments/{appointmentId}', { roles: operatorRoles, body: ref('UpdateAppointmentInput'), response: entry(ref('Appointment')) });
op('convertAppointment', 'POST', '/api/appointments/{appointmentId}/convert', { roles: operatorRoles, body: ref('VersionInput'), response: entry(ref('Order')), status: 201 });
op('listMessages', 'GET', '/api/messages', { response: paged(ref('Message')), query: { ...searchQuery, status: en('draft', 'queued', 'cancelled') } });
op('getMessage', 'GET', '/api/messages/{messageId}', { response: entry(ref('Message')) });
op('createMessage', 'POST', '/api/messages', { roles: operatorRoles, body: ref('CreateMessageInput'), response: entry(ref('Message')), status: 201 });
op('updateMessage', 'PATCH', '/api/messages/{messageId}', { roles: operatorRoles, body: ref('UpdateMessageInput'), response: entry(ref('Message')) });
op('queueMessage', 'POST', '/api/messages/{messageId}/queue', { roles: operatorRoles, body: ref('VersionInput'), response: entry(ref('Message')) });
op('cancelMessage', 'POST', '/api/messages/{messageId}/cancel', { roles: operatorRoles, body: ref('VersionInput'), response: entry(ref('Message')) });
op('getSettings', 'GET', '/api/settings', { response: entry(ref('Settings')) });
op('updateSettings', 'PATCH', '/api/settings', { roles: managerRoles, body: ref('UpdateSettingsInput'), response: entry(ref('Settings')) });
op('getDashboard', 'GET', '/api/dashboard', { response: entry(ref('Dashboard')) });
op('getReports', 'GET', '/api/reports', { roles: managerRoles, query: { ...pageQuery, type: en('summary', 'sales', 'services', 'employees', 'stock', 'cash'), from: date, to: date }, response: ref('Report'), description: 'Datas no fuso do estabelecimento. Padrão: primeiro dia do mês até hoje. Limite cinco anos. Estoque e saldo a receber são posições atuais. Cada tipo tem linhas específicas.' });

const fiscalProperties = Object.fromEntries(Object.entries(FISCAL_FIELDS).map(([name, field]) => {
  let schema;
  if (field.type === 'code') schema = str(field.length, field.length, { pattern: `^[0-9]{${field.length}}$` });
  else if (field.type === 'choice') schema = en(...field.values);
  else if (field.type === 'text') schema = str(field.max, 1);
  else if (field.type === 'integer') schema = int(field.min, field.max);
  else if (field.type === 'decimal') schema = { type: 'number', minimum: field.min, maximum: field.max, multipleOf: 0.01 };
  else if (field.type === 'date') schema = date;
  else if (field.type === 'datetime') schema = str(undefined, 0, { format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:\\d{2})$' });
  else if (field.type === 'cnpj') schema = str(14, 14, { pattern: '^[A-Z0-9]{12}[0-9]{2}$', description: 'CNPJ numérico ou alfanumérico, com dígitos verificadores válidos.' });
  else if (field.type === 'country') schema = str(2, 2, { pattern: '^[A-Z]{2}$' });
  else throw new Error(`Tipo fiscal desconhecido: ${field.type}`);
  return [name, schema];
}));
const fiscalConditional = (field, value, required) => ({
  if: { properties: { [field]: { const: value } }, required: [field] },
  then: { required },
});
S.FiscalFields = obj(fiscalProperties, REQUIRED_FISCAL_FIELDS, {
  allOf: [
    fiscalConditional('codigo_opcao_simples_nacional', '3', ['regime_tributario_simples_nacional']),
    fiscalConditional('tributacao_iss', '2', ['tipo_imunidade']),
    fiscalConditional('tributacao_iss', '3', ['codigo_pais_exportacao']),
    { if: { required: ['tipo_exigibilidade_suspensao'] }, then: { required: ['numero_processo_suspensao'] } },
    ...IBS_CBS_FIELDS.map((field) => ({ if: { required: [field] }, then: { required: IBS_CBS_FIELDS } })),
  ],
});
S.FiscalTaxReview = obj({ ibsCbsRequired: bool, justification: str(500, 10), discountTreatment: en('none', 'unconditional', 'conditional') });
S.FiscalCustomer = obj({
  taxId: str(14, 11, { pattern: '^(?:[0-9]{11}|[A-Z0-9]{12}[0-9]{2})$', description: 'CPF ou CNPJ válido, sem pontuação.' }),
  name: str(150, 1),
  address: obj({ municipalityCode: str(7, 7, { pattern: '^[0-9]{7}$' }), zipCode: str(8, 8, { pattern: '^[0-9]{8}$' }), street: str(255, 1), number: str(60, 1), neighborhood: str(60, 1), complement: str(156, 1) }, ['municipalityCode', 'zipCode', 'street', 'number', 'neighborhood']),
});
S.CreateFiscalDraftInput = obj({ orderId: identifier, customer: ref('FiscalCustomer'), fiscal: ref('FiscalFields'), taxReview: ref('FiscalTaxReview') }, undefined, {
  allOf: [{ if: { properties: { taxReview: { properties: { ibsCbsRequired: { const: true } }, required: ['ibsCbsRequired'] } }, required: ['taxReview'] }, then: { properties: { fiscal: { required: IBS_CBS_FIELDS } } } }],
  description: 'Dados fiscais explícitos revisados pelo responsável. discountTreatment=none somente quando a OS não tem desconto. O SDK não decide regime, códigos tributários ou exigência de IBS/CBS.',
});
S.FiscalStatus = obj({
  enabled: bool, disabled: bool, disabledReason: nullable(str()), provider: nullable(en('focusnfe', 'gateway')), environment: nullable(str()),
  canPrepareLocally: { const: true }, requiresInternetForEmission: { const: true }, schemaVersion: { const: FISCAL_SCHEMA_VERSION }, homologated: { const: false },
  capabilities: obj({ prepare: { const: true }, submit: bool, reconcile: bool, cancelLocalDraft: { const: true }, cancelAuthorizedInvoice: { const: false } }),
});
S.FiscalConfig = obj({
  ...S.FiscalStatus.properties,
  requiredFields: { const: REQUIRED_FISCAL_FIELDS }, fiscalFields: { const: FISCAL_FIELDS }, ibsCbsFields: { const: IBS_CBS_FIELDS },
  taxReviewRequired: { const: true }, supportedCustomer: { const: 'domestic_cpf_cnpj' }, statuses: { const: FISCAL_STATUSES },
  rules: obj({ immutableDraft: { const: true }, staleOrderMustBeRecreated: { const: true }, noAutomaticPostRetry: { const: true }, localDraftIsNotInvoice: { const: true } }),
});
const fiscalSummaryOmit = new Set(['cnpj_prestador', 'inscricao_municipal_prestador', 'descricao_servico', 'numero_processo_suspensao']);
S.FiscalSummary = obj({ ...Object.fromEntries(Object.entries(fiscalProperties).filter(([name]) => !fiscalSummaryOmit.has(name))), ibsCbsRequired: bool, discountTreatment: en('none', 'unconditional', 'conditional'), taxReviewRecorded: { const: true } }, [...REQUIRED_FISCAL_FIELDS.filter((name) => !fiscalSummaryOmit.has(name)), 'ibsCbsRequired', 'discountTreatment', 'taxReviewRecorded']);
S.FiscalOrderSnapshot = obj({
  orderId: identifier, number: int(1, Number.MAX_SAFE_INTEGER), orderVersion: version, status: orderStatus, subtotalCents: cents, discountCents: cents, totalCents: cents,
  items: arr(obj({ serviceId: identifier, name: str(), quantity, unitPriceCents: cents, lineTotalCents: cents, discountCents: cents, netCents: cents })),
});
S.FiscalDraft = obj({
  id: identifier, orderId: identifier, orderVersion: version, version: int(1, Number.MAX_SAFE_INTEGER), status: en(...FISCAL_STATUSES),
  providerRef: str(), provider: nullable(en('focusnfe', 'gateway')), environment: nullable(en('sandbox', 'production')),
  snapshot: ref('FiscalOrderSnapshot'), fiscal: ref('FiscalSummary'), customer: obj({ taxIdMasked: str() }),
  providerStatus: nullable(en('processando_autorizacao', 'autorizado', 'erro_autorizacao', 'cancelado', 'processando_cancelamento')),
  lastErrorCode: nullable(str()), attemptCount: int(), payloadRetained: bool, reconciliationRequired: bool, canCancel: bool, canSubmit: bool,
  fiscalValidity: en('provider_authorized', 'test_without_fiscal_validity', 'not_authorized'), createdAt: datetime, updatedAt: datetime,
});
S.FiscalVersionInput = obj({ version: int(1, Number.MAX_SAFE_INTEGER) });
S.FiscalPage = obj({ limit: int(1, 100), offset: int(0, 1_000_000), total: int(0, Number.MAX_SAFE_INTEGER) });
op('getFiscalStatus', 'GET', '/api/fiscal/status', { roles: managerRoles, response: ref('FiscalStatus') });
op('getFiscalConfig', 'GET', '/api/fiscal/config', { roles: managerRoles, response: ref('FiscalConfig') });
op('listFiscalDrafts', 'GET', '/api/fiscal/drafts', { roles: managerRoles, query: { limit: { ...int(1, 100), default: 50 }, offset: { ...int(0, 1_000_000), default: 0 }, status: en(...FISCAL_STATUSES), orderId: identifier }, response: obj({ items: arr(ref('FiscalDraft')), page: ref('FiscalPage') }), description: 'A página fiscal não contém hasMore; compare offset + items.length com total. Um lease expirado é apresentado como uncertain.' });
op('createFiscalDraft', 'POST', '/api/fiscal/drafts', { roles: managerRoles, body: ref('CreateFiscalDraftInput'), response: obj({ draft: ref('FiscalDraft') }), status: 201, description: 'Prepara localmente inclusive com emissão desativada; não é nota fiscal. Dados brutos do tomador e payload não são devolvidos.' });
op('getFiscalDraft', 'GET', '/api/fiscal/drafts/{draftId}', { roles: managerRoles, response: obj({ draft: ref('FiscalDraft') }) });
for (const [id, action] of [['cancelFiscalDraft', 'cancel'], ['submitFiscalDraft', 'submit'], ['reconcileFiscalDraft', 'reconcile']]) {
  op(id, 'POST', `/api/fiscal/drafts/{draftId}/${action}`, { roles: managerRoles, body: ref('FiscalVersionInput'), response: obj({ draft: ref('FiscalDraft') }), additionalStatuses: action === 'cancel' ? [] : [202], description: action === 'cancel' ? 'Cancela apenas rascunho preparado localmente; não cancela nota autorizada.' : '200 para desfecho terminal; 202 para pendência/incerteza. Repetição idempotente consulta o resultado local; não reenvia automaticamente ao provedor. Estado uncertain exige reconcile.' });
}

export function buildOpenApi() {
  const paths = {};
  for (const operation of operations) {
    const { operationId, method, path, roles, body, response, protectedWrite, status, additionalStatuses, query, pathParams, description, tags, setupToken } = operation;
    const parameters = [
      ...Object.entries(pathParams || {}).map(([name, schema]) => ({ name, in: 'path', required: true, schema })),
      ...Object.entries(query || {}).map(([name, schema]) => ({ name, in: 'query', required: false, schema })),
      ...(roles.length && method !== 'GET' ? [{ $ref: '#/components/parameters/CsrfToken' }] : []),
      ...(protectedWrite ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : []),
      ...(setupToken ? [{ $ref: '#/components/parameters/SetupToken' }] : []),
    ];
    const successHeaders = { 'X-Request-Id': { schema: str(), description: 'Identificador de correlação.' } };
    if (protectedWrite && !['addOrderPhoto', 'updatePhoto'].includes(operationId) && !path.startsWith('/api/fiscal/')) successHeaders['Idempotency-Replayed'] = { schema: en('true'), description: 'Presente quando uma resposta previamente gravada é reproduzida.' };
    if (['setup', 'login', 'changePassword', 'logout'].includes(operationId)) successHeaders['Set-Cookie'] = { schema: str(), description: 'Cookie de sessão HttpOnly; Path=/; SameSite=Strict; Secure em HTTPS. Logout expira o cookie.' };
    paths[path] ||= {};
    paths[path][method.toLowerCase()] = {
      operationId, tags, summary: operationId, ...(description ? { description } : {}),
      security: roles.length ? [{ sessionCookie: [] }] : [],
      'x-roles': roles,
      'x-idempotent-write': protectedWrite,
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
      responses: {
        ...Object.fromEntries([status, ...additionalStatuses].map((code) => [code, { description: code === 202 ? 'Operação pendente ou resultado incerto; consulte o estado do rascunho.' : 'Sucesso.', headers: successHeaders, content: { 'application/json': { schema: obj({ ok: { const: true, type: 'boolean' }, data: response }) } } }])),
        default: { $ref: '#/components/responses/ApiError' },
      },
    };
  }
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'AB-UASH API', version: '0.1.0', description: 'Contrato HTTP real do servidor AB-UASH. Dinheiro em centavos inteiros; quantidades de estoque em milésimos. A mesma API atende SQLite local e PostgreSQL. Sem tokens Supabase no cliente. Chamadas de mutação protegidas exigem Idempotency-Key, mas a API não promete processamento de pagamentos por terceiros.' },
    servers: [{ url: 'http://127.0.0.1:4173', description: 'Servidor local' }, { url: 'https://{host}', description: 'Servidor HTTPS implantado', variables: { host: { default: 'ab-uash.example.com', description: 'Host real da implantação; substitua o exemplo.' } } }],
    paths,
    components: {
      schemas,
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ab_uash_session', description: 'Sessão criada por setup/login. Navegadores usam credentials e não acessam o cookie HttpOnly.' } },
      parameters: {
        CsrfToken: { name: 'X-CSRF-Token', in: 'header', required: true, schema: str(43, 43, { pattern: '^[a-zA-Z0-9_-]{43}$' }), description: 'Token da sessão atual retornado por session, login, setup ou password.' },
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: str(128, 8, { pattern: '^[a-zA-Z0-9_-]{8,128}$' }), description: 'Chave única por usuário; repetir com mesmo método, caminho e JSON canônico. Alterar payload com a mesma chave retorna 409 IDEMPOTENCY_CONFLICT.' },
        SetupToken: { name: 'X-Setup-Token', in: 'header', required: false, schema: str(256, 32, { pattern: '^[a-zA-Z0-9_-]{32,256}$', writeOnly: true }), description: 'Obrigatório se status.setupTokenRequired=true; configurado no servidor. Ausente/incorreto: 403 SETUP_TOKEN_REQUIRED. Nunca colocar em URL nem no bundle público.' },
      },
      responses: {
        ApiError: { description: 'Erro estruturado. Exemplos: 400 JSON/chave inválida; 401 sessão ausente/revogada; 403 papel/origem/CSRF/setup token; 404 recurso; 409 conflito de versão/estado/idempotência; 413 corpo; 415 JSON exigido; 422 validação; 429 tentativas; 500 erro interno; 503 encerramento. O campo error.code identifica o caso específico.', headers: { 'X-Request-Id': { schema: str() } }, content: { 'application/json': { schema: ref('ErrorEnvelope') } } },
      },
    },
  };
}

function typeOf(schema) {
  if (!schema || !Object.keys(schema).length) return 'unknown';
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (schema.anyOf || schema.oneOf) return `(${(schema.anyOf || schema.oneOf).map(typeOf).join(' | ')})`;
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') return `Array<${typeOf(schema.items)}>`;
  if (schema.type === 'object') {
    const properties = Object.entries(schema.properties || {}).map(([name, property]) => `${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${typeOf(property)}`);
    if (schema.additionalProperties === true) properties.push('[key: string]: unknown');
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') properties.push(`[key: string]: ${typeOf(schema.additionalProperties)}`);
    if (properties.length === 0 && schema.additionalProperties === false) return 'Record<string, never>';
    return `{ ${properties.join('; ')} }`;
  }
  return 'unknown';
}
export async function generateContract() {
  const root = new URL('../', import.meta.url);
  const output = buildOpenApi();
  await mkdir(new URL('docs/api/', root), { recursive: true });
  await mkdir(new URL('sdk/src/', root), { recursive: true });
  const header = '// Generated by scripts/sdk-contract.mjs; edit the contract source, then rebuild.\n';
  await writeFile(new URL('docs/api/openapi.json', root), `${JSON.stringify(output)}\n`);
  const types = Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${typeOf(schema)};`);
  types.push('export interface OperationMap {');
  for (const operation of operations) {
    const input = obj({ ...(operation.pathParams ? { path: obj(operation.pathParams) } : {}), ...(operation.query ? { query: obj(operation.query, []) } : {}), ...(operation.body ? { body: operation.body } : {}) }, [...(operation.pathParams ? ['path'] : []), ...(operation.body ? ['body'] : [])]);
    types.push(`  ${operation.operationId}: { input: ${typeOf(input)}; output: ${typeOf(operation.response)}; protectedWrite: ${operation.protectedWrite}; setupToken: ${operation.setupToken} };`);
  }
  types.push('}');
  await writeFile(new URL('sdk/src/models.ts', root), `${header}${types.join('\n')}\n`);
  const definitions = Object.fromEntries(operations.map(({ operationId, method, path, protectedWrite, roles, pathParams, query, setupToken }) => [operationId, { method, path, protectedWrite, requiresSession: roles.length > 0, pathKeys: Object.keys(pathParams || {}), queryKeys: Object.keys(query || {}), setupToken }]));
  await writeFile(new URL('sdk/src/operations.ts', root), `${header}export const operations = ${JSON.stringify(definitions, null, 2)} as const;\n`);
  return output;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  await generateContract();
  console.log(`Contrato gerado: ${operations.length} operações, ${Object.keys(schemas).length} schemas.`);
}
