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
S.User = obj({ id: identifier, name: str(80, 2), email: str(254, 3, { format: 'email' }), role: ref('Role'), active: bool, createdAt: datetime, passwordSetupRequired: {const:true} }, ['id','name','email','role','active','createdAt']);
S.Session = obj({
  setupRequired: bool, setupTokenRequired: bool, storageMode: en('local', 'postgres'),
  user: nullable(ref('User')), csrfToken: str(43, 43), expiresAt: datetime,
}, ['setupRequired', 'setupTokenRequired', 'storageMode', 'user']);
S.AuthenticatedSession = obj({ setupRequired: { const: false, type: 'boolean' }, setupTokenRequired: bool, storageMode: en('local', 'postgres'), user: ref('User'), csrfToken: str(43, 43), expiresAt: datetime });
S.PasswordSession = obj({ setupTokenRequired: bool, storageMode: en('local', 'postgres'), user: ref('User'), csrfToken: str(43, 43), expiresAt: datetime });
S.SetupInput = obj({ name: str(80, 2), email: str(254, 3, { format: 'email' }), password: str(128, 12, { writeOnly: true }) });
S.LoginInput = obj({ email: str(254, 3, { format: 'email' }), password: str(128, 1, { writeOnly: true }) });
S.ChangePasswordInput = obj({ currentPassword: str(128, 1, { writeOnly: true }), newPassword: str(128, 12, { writeOnly: true }) });
S.CreateUserInput = {oneOf:[
  obj({...S.SetupInput.properties,role:ref('Role'),pendingPassword:{const:false}},['name','email','password','role']),
  obj({name:S.SetupInput.properties.name,email:S.SetupInput.properties.email,role:ref('Role'),pendingPassword:{const:true},password:false},['name','email','role','pendingPassword']),
],description:'Informe senha ou pendingPassword:true sem senha. A conta pendente é criada inativa, sem acesso.'};
S.SetInitialUserPasswordInput = obj({password:S.SetupInput.properties.password});
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
S.SalesReportRow = obj({ id: identifier, createdAt: datetime, source: en('order', 'invoice', 'package', 'booking'), customerName: str(), method: moneyMethods, amountCents: int(1), reference: str(120) });
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
S.JkTransition = obj({mode:en('normal','parallel_readonly'),version:int(0,Number.MAX_SAFE_INTEGER),automaticSync:{const:false},authority:en('jk','jumpcar'),historicalImportAllowed:{const:true}});
S.UpdateJkTransitionInput = obj({mode:en('normal','parallel_readonly'),version:int(0,Number.MAX_SAFE_INTEGER)});
op('getJkTransition','GET','/api/jk/transition',{response:ref('JkTransition'),description:'Modo operacional persistido; consulta paralela não sincroniza dados automaticamente.'});
op('updateJkTransition','PATCH','/api/jk/transition',{roles:adminRoles,body:ref('UpdateJkTransitionInput'),response:ref('JkTransition'),description:'Administrador altera o modo com versão, CSRF e idempotência. Operações externas pendentes impedem ativar consulta paralela; importação histórica continua sob as validações existentes.'});
S.JkArchiveKind = en('orders','customers','products');
const archiveHash = str(64,64,{pattern:'^[a-f0-9]{64}$'});
const archiveCounts = obj({rows:int(),columns:int(),duplicateOrderNumbers:int()});
const archiveTotals = nullable(obj({valueCents:aggregateCents,discountCents:aggregateCents}));
const archiveDates = nullable(obj({entryMin:nullable(date),entryMax:nullable(date),exitMin:nullable(date),exitMax:nullable(date)}));
S.JkHistoryArchiveInput = obj({content:str(8*1024*1024),previewHash:archiveHash},['content']);
S.CommitJkHistoryArchiveInput = obj({content:str(8*1024*1024),previewHash:archiveHash});
S.JkHistoryArchiveReport = obj({status:en('PREVIEW','REJECTED','COMMITTED','REPLAYED'),mode:en('documentary'),kind:ref('JkArchiveKind'),sourceVerified:{const:false},provenance:en('snapshot-row'),canCommit:bool,snapshotHash:archiveHash,counts:archiveCounts,totals:archiveTotals,dates:archiveDates,issues:arr(obj({code:str(),message:str()})),replayAvailable:bool,previewHash:archiveHash,batchId:identifier,committedAt:datetime,replayed:bool},['status','mode','kind','sourceVerified','provenance','canCommit','snapshotHash','counts','totals','dates','issues','replayAvailable','previewHash']);
S.JkHistoryArchiveStatus = {oneOf:[obj({supported:{const:false},mode:en('documentary'),kind:ref('JkArchiveKind'),reason:en('SQLITE_LOCAL_REQUIRED')}),obj({supported:{const:true},mode:en('documentary'),kind:ref('JkArchiveKind'),sourceVerified:{const:false},counts:archiveCounts,totals:archiveTotals,dates:archiveDates,snapshotHash:nullable(archiveHash),committedAt:nullable(datetime),batchId:identifier},['supported','mode','kind','sourceVerified','counts','totals','dates','snapshotHash','committedAt'])]};
S.JkHistoryArchiveRows = obj({mode:en('documentary'),kind:ref('JkArchiveKind'),headers:arr(str()),items:arr(obj({id:str(),sourceRow:int(1),sourceNumber:nullable(str()),values:arr(str())})),page:ref('Page')});
op('getJkHistoryArchiveStatus','GET','/api/jk/history-archive/status',{roles:adminRoles,query:{kind:ref('JkArchiveKind')},response:ref('JkHistoryArchiveStatus')});
op('listJkHistoryArchiveRows','GET','/api/jk/history-archive/rows',{roles:adminRoles,query:{kind:ref('JkArchiveKind'),limit:{...int(1,500),default:25},offset:{...int(),default:0},q:str(200)},response:ref('JkHistoryArchiveRows')});
op('previewJkHistoryArchive','POST','/api/jk/history-archive/preview',{roles:adminRoles,body:ref('JkHistoryArchiveInput'),response:ref('JkHistoryArchiveReport'),protectedWrite:false,description:'Prévia documental local SQLite, com CSRF. Não cria operações, clientes ou estoque. Conteúdo limitado a 8 MiB UTF-8; origem não verificada.'});
op('commitJkHistoryArchive','POST','/api/jk/history-archive/commit',{roles:adminRoles,body:ref('CommitJkHistoryArchiveInput'),response:ref('JkHistoryArchiveReport'),status:201,additionalStatuses:[200],description:'Preserva um snapshot por tipo; exige prévia e idempotência. Não sincroniza nem gera efeitos operacionais.'});
const migrationEntities=['customers','vehicles','services','orders','orderItems','payments'];
const migrationSourceId=str(256,1,{pattern:'^[^\\s]+$',description:'ID estável fornecido pela origem no contrato canônico; não fabricar a partir de nome, e-mail, linha ou ID técnico do JK.'});
const migrationImportId=str(100,1,{pattern:'^jk_[A-Za-z]+_[a-f0-9]{32}$',description:'ID técnico de importação conhecido; usar no campo ...ImportId sem apresentá-lo como sourceId Jumpcar.'});
const migrationTimestamp=nullable({anyOf:[str(40,20,{format:'date-time'}),{const:''}]});
const migrationBaseRecord={sourceId:migrationSourceId,createdAt:migrationTimestamp};
const migrationReferenceProperties=prefix=>({[`${prefix}SourceId`]:migrationSourceId,[`${prefix}ImportId`]:migrationImportId});
const migrationReferenceRules=prefix=>({oneOf:[{required:[`${prefix}SourceId`],properties:{[`${prefix}ImportId`]:false}},{required:[`${prefix}ImportId`],properties:{[`${prefix}SourceId`]:false}}]});
S.JkMigrationCustomerInput=obj({...migrationBaseRecord,name:str(120,2),phone:str(30),email:str(254),kind:en('individual','company'),postpaid:bool,notes:memo,active:bool},['sourceId','name']);
S.JkMigrationVehicleInput=obj({...migrationBaseRecord,...migrationReferenceProperties('customer'),plate:str(16,4),model:str(100,1),color:str(60),category:en('small','medium','large','motorcycle'),active:bool},['sourceId','plate','model'],{allOf:[migrationReferenceRules('customer')]});
S.JkMigrationServiceInput=obj({...migrationBaseRecord,name:str(120,1),priceCents:cents,durationMinutes:int(1,1440),commissionBps:int(0,10000),active:bool},['sourceId','name','priceCents','durationMinutes']);
S.JkMigrationOrderInput=obj({...migrationBaseRecord,createdAt:str(40,20,{format:'date-time'}),number:str(80,1),...migrationReferenceProperties('customer'),...migrationReferenceProperties('vehicle'),status:orderStatus,subtotalCents:cents,discountCents:cents,totalCents:cents,notes:memo,deliveredAt:migrationTimestamp},['sourceId','createdAt','number','status','subtotalCents','totalCents'],{allOf:['customer','vehicle'].map(migrationReferenceRules)});
S.JkMigrationOrderItemInput=obj({...migrationBaseRecord,...migrationReferenceProperties('order'),...migrationReferenceProperties('service'),name:str(120,1),quantity:int(1,100000),unitPriceCents:cents,lineTotalCents:cents,discountCents:cents,netCents:cents,historicalCommissionCents:cents},['sourceId','name','quantity','unitPriceCents','lineTotalCents','netCents'],{allOf:['order','service'].map(migrationReferenceRules)});
S.JkMigrationPaymentInput=obj({...migrationBaseRecord,createdAt:str(40,20,{format:'date-time'}),...migrationReferenceProperties('order'),...migrationReferenceProperties('customer'),amountCents:int(1),method:moneyMethods,reference:str(200)},['sourceId','createdAt','amountCents','method'],{allOf:['order','customer'].map(migrationReferenceRules)});
S.JkMigrationDataset=obj({schemaVersion:{const:1},...Object.fromEntries(['Customer','Vehicle','Service','Order','OrderItem','Payment'].map((name,index)=>[migrationEntities[index],arr(ref(`JkMigration${name}Input`),{maxItems:20000})]))},['schemaVersion'],{description:'JK schemaVersion 1. Ao menos um registro e até 20.000 no conjunto. Valores/referências/totais também são reconciliados pelo servidor.'});
S.JkMigrationFile=obj({entity:en(...migrationEntities),format:en('csv','jumpcar-html'),content:str(8*1024*1024,1)});
const migrationEnvelope={source:{const:'jumpcar'},scope:{const:'jk'},mode:{const:'historical'},previewHash:archiveHash};
const migrationInputBranches=[
  obj({...migrationEnvelope,dataset:ref('JkMigrationDataset'),files:false,nativeCustomerMode:false},['source','dataset']),
  obj({...migrationEnvelope,files:arr(ref('JkMigrationFile'),{minItems:1,maxItems:6}),dataset:false,nativeCustomerMode:false},['source','files']),
  obj({...migrationEnvelope,nativeCustomerMode:en('customers-only','customers-and-vehicles'),files:arr(obj({entity:{const:'customers'},format:en('csv','jumpcar-html'),content:str(8*1024*1024,1)}),{minItems:1,maxItems:1}),dataset:false},['source','nativeCustomerMode','files']),
];
S.JkMigrationInput={oneOf:migrationInputBranches,description:'Escolha explícita nativeCustomerMode somente com UM arquivo nativo de clientes CSV/HTML com nove colunas intactas. Ausência preserva comportamento anterior. Não modificar BOM/conteúdo do arquivo: snapshotHash usa texto literal. Máximo total 8 MiB.'};
S.CommitJkMigrationInput={oneOf:migrationInputBranches.map(branch=>({...branch,required:[...branch.required,'previewHash']})),description:'Mesmo corpo e opção da prévia mais previewHash. Alterar a opção ou conteúdo exige nova prévia e confirmação.'};
S.JkNativeCustomerImport=obj({mode:en('customers-only','customers-and-vehicles'),sourceRows:int(0,20000),sourceColumns:{const:9},snapshotHash:archiveHash,deferredVehicleEntries:int(0,Number.MAX_SAFE_INTEGER),deferredVehicleRows:int(0,20000),ambiguousVehicleRows:int(0,20000),reason:en('EXPLICIT_CUSTOMERS_ONLY','NATIVE_PLATE_EXTRACTION')});
const migrationCounts=obj(Object.fromEntries(migrationEntities.map(entity=>[entity,obj({received:int(0,20000),insert:int(0,20000),unchanged:int(0,20000),rejected:int(0,20000)})])));
const migrationReconciliation=obj({ordersTotalCents:aggregateCents,itemNetTotalCents:aggregateCents,paymentsTotalCents:aggregateCents,historicalOutstandingCents:int(-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),operationalWrites:obj(Object.fromEntries(['orders','payments','cashMovements','invoices','fiscalDocuments','messages','stockMovements','commissions'].map(key=>[key,{const:0}])))});
S.JkMigrationIdentity=obj({entity:en('customers','vehicles'),row:int(2,20001),importId:{...migrationImportId,readOnly:true},sourceId:{const:null,readOnly:true,description:'O arquivo nativo não fornece ID Jumpcar. Identidade é snapshot/linha, sem fabricar sourceId.'},provenance:{const:'snapshot-row',readOnly:true},snapshotHash:archiveHash});
S.JkMigrationReport=obj({status:en('PREVIEW','REJECTED','COMMITTED','REPLAYED'),previewHash:archiveHash,inputHash:archiveHash,canCommit:bool,mode:{const:'historical'},source:{const:'jumpcar'},scope:{const:'jk'},counts:migrationCounts,issues:arr(obj({entity:str(),row:nullable(int(1)),code:str(),message:str(),field:str()},['entity','row','code','message'])),totalIssueCount:int(),warnings:arr(obj({code:str(),message:str(),count:int()},['code','message'])),reconciliation:migrationReconciliation,identityMap:arr(ref('JkMigrationIdentity')),sourceVerified:{const:false},nativeCustomerImport:ref('JkNativeCustomerImport'),replayAvailable:bool,replayed:bool,batchId:identifier,committedAt:datetime},['status','previewHash','inputHash','canCommit','mode','source','scope','counts','issues','totalIssueCount','warnings','reconciliation','identityMap','sourceVerified']);
S.JkMigrationStatus={oneOf:[obj({supported:{const:false},mode:{const:'historical'},source:{const:'jumpcar'},scope:{const:'jk'},reason:{const:'SQLITE_LOCAL_REQUIRED'},limits:obj({maxBytes:{const:8388608},maxRows:{const:20000}})}),obj({supported:{const:true},mode:{const:'historical'},source:{const:'jumpcar'},scope:{const:'jk'},counts:obj(Object.fromEntries(migrationEntities.map(entity=>[entity,aggregateCents]))),totals:obj({ordersTotalCents:aggregateCents,paymentsTotalCents:aggregateCents,historicalOutstandingCents:aggregateCents}),limits:obj({maxBytes:{const:8388608},maxRows:{const:20000}}),latestBatches:arr(obj({batchId:identifier,committedAt:datetime,counts:migrationCounts,reconciliation:migrationReconciliation,previewHash:archiveHash,nativeCustomerImport:ref('JkNativeCustomerImport')},['batchId','committedAt','counts','reconciliation','previewHash']))})]};
S.JkMigrationHistory=obj({mode:{const:'historical'},items:arr({type:'object',additionalProperties:true,description:'Registro histórico em camelCase, conforme query.entity. sourceRows preserva dataJson com as nove colunas, snapshotHash e sourceRow. Não contém ID Jumpcar fabricado.'}),page:ref('Page')});
op('getJkMigrationStatus','GET','/api/jk/migration/status',{roles:adminRoles,response:ref('JkMigrationStatus')});
op('getJkMigrationHistory','GET','/api/jk/migration/history',{roles:adminRoles,query:{entity:en('orders','orderItems','payments','sourceRows'),limit:{...int(1,500),default:100},offset:{...int(),default:0}},response:ref('JkMigrationHistory')});
op('previewJkMigration','POST','/api/jk/migration/preview',{roles:adminRoles,body:ref('JkMigrationInput'),response:ref('JkMigrationReport'),protectedWrite:false,description:'Prévia sem escrita, com CSRF e administrador atual. customers-only não cria veículos nem presume proprietários; preserva linhas e IDs técnicos snapshot-row/sourceId:null.'});
op('commitJkMigration','POST','/api/jk/migration/commit',{roles:adminRoles,body:ref('CommitJkMigrationInput'),response:ref('JkMigrationReport'),status:201,additionalStatuses:[200],description:'Administrador atual, CSRF, previewHash e idempotência. Mesmo arquivo e opção da prévia. Commit atômico; replay 200 sem duplicação. Histórico não gera caixa, OS operacional, estoque ou folha.'});
const reconciliationMode={mode:en('documentary'),sourceVerified:{const:false}};
const reconciliationHashes=obj({customers:archiveHash,orders:archiveHash});
S.JkVehicleReviewInput=obj({vehicleRef:identifier,category:en('small','medium','large','motorcycle'),model:str(100,1),color:str(60)},['vehicleRef','category','model']);
S.JkReconciliationInput=obj({vehicleReviews:arr(ref('JkVehicleReviewInput'),{maxItems:500}),previewHash:archiveHash},[]);
S.CommitJkReconciliationInput=obj(S.JkReconciliationInput.properties,['previewHash']);
S.JkReconciliationCounts=obj({vehicles:obj({eligible:int(),staged:int(),promoted:int(),pendingReview:int(),conflictGroups:int(),conflictingEntries:int(),ambiguousCustomerRows:int(),ambiguousTokenCollisions:int()}),history:obj({rows:int(),proposal:int(),insufficientIdentity:int(),identityMismatch:int(),plateConflict:int(),plateAbsent:int(),invalidPlate:int()})});
S.JkReconciliationReport=obj({supported:{const:true},ready:{const:true},status:en('PREVIEW','COMMITTED','REPLAYED'),...reconciliationMode,snapshotHashes:reconciliationHashes,counts:ref('JkReconciliationCounts'),inputHash:archiveHash,previewHash:archiveHash,canCommit:bool,replayAvailable:bool,operationalWrites:obj({customers:{const:0},vehicles:int(0,500),orders:{const:0},payments:{const:0},cashMovements:{const:0},invoices:{const:0},stockMovements:{const:0},commissions:{const:0}}),documentaryWrites:obj({vehicles:int(),history:int()}),warnings:arr(str()),batchId:identifier,committedAt:datetime,replayed:bool},['supported','ready','status','mode','sourceVerified','snapshotHashes','counts','inputHash','previewHash','canCommit','replayAvailable','operationalWrites','documentaryWrites','warnings']);
S.JkReconciliationStatus={oneOf:[obj({supported:{const:false},...reconciliationMode}),obj({supported:{const:true},ready:{const:false},...reconciliationMode,requiredArchives:arr(en('customers','orders'))}),obj({supported:{const:true},ready:{const:true},...reconciliationMode,snapshotHashes:reconciliationHashes,counts:ref('JkReconciliationCounts'),latestBatch:nullable(obj({batchId:identifier,committedAt:datetime}))})]};
S.JkReconciliationVehicle=obj({vehicleRef:identifier,customerId:identifier,customerName:str(),plate:str(16),sourceRow:int(1),snapshotHash:archiveHash,sourceId:{type:'null',readOnly:true},status:en('awaiting_review','promoted'),category:nullable(en('small','medium','large','motorcycle')),model:nullable(str(100,1)),color:nullable(str(60)),vehicleId:nullable(identifier)});
S.JkHistoryProposalStatus=en('proposal','insufficient_identity','identity_mismatch','plate_conflict','plate_absent','invalid_plate');
S.JkReconciliationHistoryRow=obj({id:str(),sourceRow:int(1),sourceNumber:str(),values:arr(str(),{minItems:30,maxItems:30}),proposal:obj({status:ref('JkHistoryProposalStatus'),candidateCustomerId:nullable(identifier),vehicleRef:nullable(identifier),sourceVerified:{const:false}})});
S.JkReconciliationVehicles=obj({...reconciliationMode,items:arr(ref('JkReconciliationVehicle')),page:ref('Page')});
S.JkReconciliationHistory=obj({...reconciliationMode,headers:arr(str(),{minItems:30,maxItems:30}),items:arr(ref('JkReconciliationHistoryRow')),page:ref('Page')});
const reconciliationQuery={limit:{...int(1,500),default:25},offset:{...int(),default:0},customerId:str(100),plate:str(16)};
op('getJkReconciliationStatus','GET','/api/jk/reconciliation/status',{roles:adminRoles,response:ref('JkReconciliationStatus')});
op('listJkReconciliationVehicles','GET','/api/jk/reconciliation/vehicles',{roles:adminRoles,query:{...reconciliationQuery,status:en('awaiting_review','promoted')},response:ref('JkReconciliationVehicles')});
op('listJkReconciliationHistory','GET','/api/jk/reconciliation/history',{roles:adminRoles,query:{...reconciliationQuery,status:ref('JkHistoryProposalStatus')},response:ref('JkReconciliationHistory'),description:'Linhas documentais preservadas; customerId filtra candidatos, inclusive divergentes. A proposta não comprova identidade, propriedade ou pagamento.'});
op('previewJkReconciliation','POST','/api/jk/reconciliation/preview',{roles:adminRoles,body:ref('JkReconciliationInput'),response:ref('JkReconciliationReport'),protectedWrite:false,description:'Prévia somente leitura dos acervos já preservados e das identidades snapshot-row existentes. Sem vehicleReviews, não cria veículos operacionais; categoria/modelo permanecem desconhecidos.'});
op('commitJkReconciliation','POST','/api/jk/reconciliation/commit',{roles:adminRoles,body:ref('CommitJkReconciliationInput'),response:ref('JkReconciliationReport'),status:201,additionalStatuses:[200],description:'Hash, administrador atual, CSRF e idempotência. Preserva vínculos/propostas documentais; promove apenas veículos explicitamente revisados com categoria e modelo, sem substituir proprietário nem criar pagamentos.'});
S.JkSourceCatalogCollection=en('services','products','balances');
const sourceRowFields={sourceRow:int(1),sourceId:nullable(str(256,1,{pattern:'^[^\\s]+$'})),name:str(240,1),raw:{type:'object',maxProperties:80,propertyNames:str(120,1),additionalProperties:{anyOf:[str(6000),int(-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),bool,{type:'null'}]}}};
S.JkSourceService=obj({...sourceRowFields,category:nullable(str(240)),priceCents:nullable(cents),active:nullable(bool),schedulingEnabled:nullable(bool),durationMinutes:nullable(int(1,1440)),commissionBps:nullable(int(0,10000))});
S.JkSourceProduct=obj({...sourceRowFields,...Object.fromEntries(['sku','brand','category','application','unit','unitsPerItem','sourceQuantity','sourceMinimumQuantity'].map(key=>[key,nullable(str(240))])),priceCents:nullable(cents),costCents:nullable(cents),active:nullable(bool)});
S.JkSourceBalance=obj({...sourceRowFields,kind:en('account','cash','receivable','payable','customer-credit','package-credit','other'),amountCents:nullable(int(-1_000_000_000)),currency:{const:'BRL'},status:nullable(str(240)),asOf:nullable(datetime)});
S.JkSourceCatalogSnapshot=obj({schemaVersion:{const:1},source:{const:'jumpcar-ui'},establishmentId:{const:24453},observedAt:datetime,services:arr(ref('JkSourceService'),{maxItems:20000}),products:arr(ref('JkSourceProduct'),{maxItems:20000}),balances:arr(ref('JkSourceBalance'),{maxItems:20000})},undefined,{description:'De 1 a 20.000 linhas no total, até 8 MiB. Cada campo de linha é obrigatório; use null para desconhecido. IDs técnicos não substituem sourceId real.'});
S.JkSourceCatalogInput=obj({snapshot:ref('JkSourceCatalogSnapshot'),previewHash:archiveHash},['snapshot']);
S.CommitJkSourceCatalogInput=obj(S.JkSourceCatalogInput.properties);
const sourceCounts=obj({services:int(),products:int(),balances:int()});
const sourceStatuses=obj(Object.fromEntries(['services','products','balances'].map(key=>[key,obj({active:int(),inactive:int(),unknown:int()})])));
const sourceReportFields={status:en('PREVIEW','COMMITTED','REPLAYED'),mode:{const:'source-reference'},source:{const:'jumpcar-ui'},establishmentId:{const:24453},observedAt:datetime,sourceVerified:{const:false},operational:{const:false},canCommit:bool,counts:sourceCounts,statuses:sourceStatuses,snapshotHash:archiveHash,issues:arr({}),replayAvailable:bool,operationalWrites:obj(Object.fromEntries(['services','products','orders','payments','cashMovements','invoices','stockMovements','packages'].map(key=>[key,{const:0}]))),previewHash:archiveHash,batchId:identifier,committedAt:datetime,replayed:bool};
const sourceReportRequired=Object.keys(sourceReportFields).filter(key=>!['batchId','committedAt','replayed'].includes(key));
S.JkSourceCatalogReport=obj(sourceReportFields,sourceReportRequired);
S.JkSourceCatalogStatus={oneOf:[obj({supported:{const:false},mode:{const:'source-reference'},reason:{const:'SQLITE_LOCAL_REQUIRED'}}),obj({supported:{const:true},mode:{const:'source-reference'},status:{const:'not_imported'},sourceVerified:{const:false},operational:{const:false},counts:sourceCounts,snapshotHash:{type:'null'},totalSnapshots:int()}),obj({...sourceReportFields,supported:{const:true},totalSnapshots:int()},[...sourceReportRequired,'batchId','committedAt','replayed','supported','totalSnapshots'])]};
S.JkSourceCatalogProvenance=obj({source:{const:'jumpcar-ui'},establishmentId:{const:24453},snapshotHash:archiveHash,collection:ref('JkSourceCatalogCollection'),sourceRow:int(1),observedAt:datetime});
S.JkSourceCatalogRows={oneOf:[['services','JkSourceService'],['products','JkSourceProduct'],['balances','JkSourceBalance']].map(([collection,name])=>obj({mode:{const:'source-reference'},collection:{const:collection},operational:{const:false},items:arr(obj({id:str(),...S[name].properties,provenance:ref('JkSourceCatalogProvenance')})),page:ref('Page')}))};
op('getJkSourceCatalogStatus','GET','/api/jk/source-catalog/status',{roles:adminRoles,response:ref('JkSourceCatalogStatus')});
op('listJkSourceCatalogRows','GET','/api/jk/source-catalog/rows',{roles:adminRoles,query:{collection:ref('JkSourceCatalogCollection'),limit:{...int(1,500),default:25},offset:{...int(),default:0},q:str(200)},response:ref('JkSourceCatalogRows'),description:'Consulta a última versão imutável de referências da origem; valores desconhecidos são null, quantidades permanecem texto e saldos não viram lançamentos.'});
op('previewJkSourceCatalog','POST','/api/jk/source-catalog/preview',{roles:adminRoles,body:ref('JkSourceCatalogInput'),response:ref('JkSourceCatalogReport'),protectedWrite:false,description:'Prévia sem escrita, com administrador atual e CSRF. Não ativa serviços/produtos nem converte saldos de origem em caixa.'});
op('commitJkSourceCatalog','POST','/api/jk/source-catalog/commit',{roles:adminRoles,body:ref('CommitJkSourceCatalogInput'),response:ref('JkSourceCatalogReport'),status:201,additionalStatuses:[200],description:'Preserva snapshot imutável com hash da prévia e idempotência; nova versão completa não soma saldos nem altera catálogos operacionais.'});
S.JkTefProvider = obj({id:str(),label:str(),platform:str(),integrationMode:str(),description:str(),requirements:arr(str()),documentationUrl:str(undefined,0,{format:'uri'}),sdkUrl:str(undefined,0,{format:'uri'}),licenseNote:str(),connectorImplemented:{const:false},reviewedAt:date,preparationSteps:arr(obj({id:str(),action:str(),evidence:str()}))},['id','label','platform','integrationMode','description','requirements','documentationUrl','connectorImplemented','reviewedAt','preparationSteps']);
S.JkTefSelection = obj({providerId:str(),terminalModel:str(100),notes:str(500)});
S.JkTefPlan = obj({version:int(0,Number.MAX_SAFE_INTEGER),providers:arr(ref('JkTefSelection')),state:en('preparation_only'),canSubmit:{const:false},connectionVerified:{const:false},homologated:{const:false}});
S.UpdateJkTefPlanInput = obj({version:int(0,Number.MAX_SAFE_INTEGER-1),providers:arr(ref('JkTefSelection'))});
op('getJkTefCatalog','GET','/api/jk/tef/catalog',{roles:managerRoles,response:obj({providers:arr(ref('JkTefProvider'))}),description:'Catálogo de preparação; nenhum conector TEF implementado ou homologado.'});
op('getJkTefPlan','GET','/api/jk/tef/plan',{roles:managerRoles,response:ref('JkTefPlan')});
op('updateJkTefPlan','PATCH','/api/jk/tef/plan',{roles:adminRoles,body:ref('UpdateJkTefPlanInput'),response:ref('JkTefPlan'),description:'Salva metadados de preparação com versão, CSRF e idempotência, inclusive em consulta paralela. Não recebe credenciais nem ativa cobranças.'});
S.JkTefDiagnostics = obj({state:en('preparation_only'),canSubmit:{const:false},connectionVerified:{const:false},homologated:{const:false},localOnly:{const:true},networkAttempted:{const:false},hardwareInspected:{const:false},planVersion:int(0,Number.MAX_SAFE_INTEGER),selectedCount:int(0,7),providers:arr(obj({providerId:str(),selected:bool,terminalModelInformed:bool,connectorImplemented:{const:false},state:en('not_selected','terminal_model_missing','connector_missing')}))});
op('getJkTefDiagnostics','GET','/api/jk/tef/diagnostics',{roles:managerRoles,response:ref('JkTefDiagnostics'),description:'Somente confere o plano salvo; não acessa máquina, rede ou segredos e não habilita cobrança.'});
S.JkTeamMemberInput = obj({name:str(80,2),email:str(254,3,{format:'email'}),phone:str(40),sourceRole:str(80,1),role:en('manager','operator','viewer'),createEmployee:bool},['name','email','sourceRole','role','createEmployee']);
S.JkTeamMember = obj(S.JkTeamMemberInput.properties);
S.JkTeamInput = obj({source:{const:'jumpcar-ui'},establishmentId:{const:24453},users:arr(ref('JkTeamMemberInput'),{minItems:1,maxItems:100}),previewHash:archiveHash},['source','establishmentId','users']);
S.CommitJkTeamInput = obj(S.JkTeamInput.properties);
const teamCounts=obj({users:int(0,100),employees:int(0,100)});
S.JkTeamPreview = obj({canCommit:bool,previewHash:archiveHash,counts:teamCounts,users:arr(ref('JkTeamMember')),issues:arr(obj({row:int(0,100),code:en('EMAIL_EXISTS','EMPLOYEE_NAME_EXISTS','EMPLOYEE_NAME_REPEATED','TEAM_ALREADY_IMPORTED')})),accessEnabled:{const:false},payrollEnabled:{const:false}});
S.JkTeamCommit = obj({status:{const:'preserved_pending_activation'},counts:teamCounts,source:{const:'jumpcar-ui'},establishmentId:{const:24453},snapshotHash:archiveHash,committedAt:datetime,accessEnabled:{const:false},payrollEnabled:{const:false},entries:arr(obj({userId:identifier,employeeId:nullable(identifier),sourceRole:str(80,1),sourceStatus:{const:'active'},phone:str(40),compensationConfigured:{const:false}}))});
S.JkTeamStatus = {oneOf:[obj({status:{const:'not_imported'},counts:obj({users:{const:0},employees:{const:0}})}),ref('JkTeamCommit')]};
op('getJkTeamStatus','GET','/api/jk/team/status',{roles:adminRoles,response:ref('JkTeamStatus')});
op('previewJkTeam','POST','/api/jk/team/preview',{roles:adminRoles,body:ref('JkTeamInput'),response:ref('JkTeamPreview'),protectedWrite:false,description:'Prévia administrativa com CSRF, sem escrita nem ativação. Não cria senhas nem resolve vínculos por nome.'});
op('commitJkTeam','POST','/api/jk/team/commit',{roles:adminRoles,body:ref('CommitJkTeamInput'),response:ref('JkTeamCommit'),status:201,description:'Exige hash da prévia e idempotência. Preserva contas e profissionais inativos, sem senha, salário ou comissão configurados.'});

const channelBase={id:str(),label:str(),configured:bool,provider:nullable(str()),environment:en('not-configured','homologation','production'),state:en('blocked','ready'),blockers:arr(str()),canPrepareLocally:bool,connectionVerified:bool,homologated:{const:false}};
S.JkPixReadiness = obj({...channelBase,id:{const:'pix'},provider:nullable(en('pix-efi','pix-inter','pix-asaas')),connectionVerified:{const:false},capabilities:obj({prepare:bool,submit:bool,reconcile:bool,settleProductionOnly:{const:true}})});
const messageReadiness={...channelBase,id:{const:'whatsapp'},provider:nullable(en('whatsapp-cloud','whatsapp-baileys')),capabilities:obj({prepare:bool,submit:bool,verifyDelivery:{const:false}})};
S.JkWhatsAppReadiness = obj({...messageReadiness,connection:en('disconnected','connecting','connected','connection-error','storage-error','account-mismatch','reauth-required','reconnect-exhausted','reconnecting','closed'),sendEnabled:bool,qrAvailable:bool,reconnectAttempts:int(),deliveryVerified:{const:false}},Object.keys(messageReadiness),{description:'Campos connection/sendEnabled/qrAvailable/deliveryVerified aparecem quando o serviço Baileys foi configurado; reconnectAttempts depende de uma instância iniciada. Conexão Baileys não prova entrega.'});
S.JkFiscalReadiness = obj({id:{const:'fiscal'},label:str(),state:en('blocked','ready'),configured:bool,provider:nullable(en('focusnfe','gateway')),environment:str(),blockers:arr(str()),canPrepareLocally:{const:true},capabilities:obj({prepare:{const:true},submit:bool,reconcile:bool}),createDraftEndpoint:{const:'/api/fiscal/drafts'},invoiceOrigin:{const:'immutable-order-snapshot'},homologated:{const:false}});
S.JkIntegrationReadiness = obj({pix:ref('JkPixReadiness'),whatsapp:ref('JkWhatsAppReadiness'),fiscal:ref('JkFiscalReadiness'),storageReady:bool,rules:obj({noAutomaticMutationRetry:{const:true},providerAcceptanceIsNotDelivery:{const:true},pixRequiresAuthenticatedEvidence:{const:true},homologationNeverSettles:{const:true}})});
const jkRecordProperties={id:identifier,kind:en('pix','whatsapp'),orderId:identifier,orderVersion:version,version,status:en('prepared','submitting','active','reconciling','uncertain','pending','partial','review','test_confirmed','settled','accepted','rejected','cancelled'),provider:nullable(en('pix-efi','pix-inter','pix-asaas','whatsapp-cloud','whatsapp-baileys')),environment:en('not-configured','homologation','production'),amountCents:cents,providerReference:nullable(str()),paymentId:nullable(identifier),lastErrorCode:nullable(str()),attemptCount:int(),evidence:{type:'object',additionalProperties:true,description:'Evidência sanitizada específica do provedor. Aceitação não confirma entrega, notificação não quita e homologação nunca baixa produção.'},reconciliationRequired:bool,paymentConfirmed:bool,delivery:{const:'unconfirmed'},preparationRequiresRefresh:bool,canSubmit:bool,canReconcile:bool,canCancel:bool,templateName:str(128,1),recipientMasked:str(),customerId:str(104,5,{pattern:'^cus_[A-Za-z0-9]{1,100}$'}),dueDate:date,createdAt:datetime,updatedAt:datetime};
S.JkIntegrationRecord = obj(jkRecordProperties,Object.keys(jkRecordProperties).filter(name=>!['templateName','recipientMasked','customerId','dueDate'].includes(name)),{allOf:[{if:{properties:{kind:{const:'whatsapp'}},required:['kind']},then:{required:['templateName','recipientMasked']}},{if:{properties:{provider:{const:'pix-asaas'}},required:['provider']},then:{required:['customerId','dueDate']}}]});
S.JkIntegrationEvent = obj({action:str(),status:str(),code:nullable(str()),createdAt:datetime});
S.PrepareJkPixInput = {oneOf:[
  obj({version,expiresInSeconds:{...int(60,86400),default:3600},customerId:false,dueDate:false},['version']),
  obj({version,customerId:jkRecordProperties.customerId,dueDate:date,expiresInSeconds:false},['version','customerId','dueDate']),
],description:'O provedor configurado no servidor define o ramo: Asaas exige customerId e dueDate e não aceita expiresInSeconds; Efí/Inter ou preparação sem provedor aceitam somente version e expiresInSeconds opcional.'};
S.PrepareJkMessageInput = obj({version,templateName:str(128,1,{pattern:'^[a-z0-9_]{1,128}$'}),languageCode:str(6,2,{pattern:'^[a-z]{2,3}(?:_[A-Z]{2})?$'}),bodyParameters:arr(str(1024,1),{maxItems:30}),consentConfirmed:{const:true}},['version','templateName','languageCode','consentConfirmed'],{description:'Destinatário vem do cliente da ordem; não aceita telefone ou texto livre. Cloud usa modelo aprovado, Baileys exige modelo local configurado com este nome/idioma.'});
S.ReconcileJkPixInput = obj({version,start:str(40,20,{format:'date-time'}),end:str(40,20,{format:'date-time'})},['version'],{description:'Janela com fuso explícito, até 31 dias, após o envio. Para registros antigos, informe intervalo explícito. Nunca reenvia a cobrança.'});
S.JkOrderIntegrations = obj({pixCharges:arr(ref('JkIntegrationRecord')),messages:arr(ref('JkIntegrationRecord')),fiscalDrafts:arr(ref('FiscalDraft'))});
S.JkFiscalSource = obj({orderId:identifier,orderNumber:int(1,Number.MAX_SAFE_INTEGER),orderVersion:version,status:orderStatus,totalCents:cents,eligible:bool,items:arr(obj({serviceId:identifier,name:str(),quantity,netCents:cents})),createDraftEndpoint:{const:'/api/fiscal/drafts'},requiredConfigurationEndpoint:{const:'/api/fiscal/config'},taxReviewRequired:{const:true}});
op('getJkIntegrationReadiness','GET','/api/jk/integrations/readiness',{response:ref('JkIntegrationReadiness'),description:'Configuração e disponibilidade local. ready não prova homologação, aceitação de credenciais ou entrega.'});
op('getJkOrderIntegrations','GET','/api/jk/orders/{orderId}/integrations',{response:ref('JkOrderIntegrations'),description:'Sem paginação: consulta no máximo 100 registros Pix/mensagens combinados e 100 rascunhos fiscais da ordem.'});
op('getJkOrderFiscalSource','GET','/api/jk/orders/{orderId}/fiscal-source',{response:ref('JkFiscalSource')});
op('prepareJkPix','POST','/api/jk/orders/{orderId}/pix',{roles:managerRoles,body:ref('PrepareJkPixInput'),response:entry(ref('JkIntegrationRecord')),status:201,additionalStatuses:[202],description:'Intenção local pelo saldo atual da ordem. Asaas exige cliente externo e vencimento; não aceita expiresInSeconds. Não cobra nem quita nesta ação.'});
op('prepareJkMessage','POST','/api/jk/orders/{orderId}/messages',{roles:managerRoles,body:ref('PrepareJkMessageInput'),response:entry(ref('JkIntegrationRecord')),status:201,additionalStatuses:[202]});
for(const [channel,name,param] of [['pix','Pix','pixId'],['messages','Message','messageId']]){
  const path=`/api/jk/${channel}/{${param}}`;
  op(`getJk${name}`,'GET',path,{response:obj({item:ref('JkIntegrationRecord'),events:arr(ref('JkIntegrationEvent'))})});
  for(const action of channel==='pix'?['submit','reconcile','cancel']:['submit','cancel']){
    op(`${action}Jk${name}`,'POST',`${path}/${action}`,{roles:managerRoles,body:ref(action==='reconcile'?'ReconcileJkPixInput':'VersionInput'),response:entry(ref('JkIntegrationRecord')),additionalStatuses:[202],description:action==='cancel'?'Cancela somente preparação nunca enviada; não cancela no provedor.':'200 ou 202 pendente/incerto. Replay idempotente recupera estado local; não há retry automático. Aceitação não comprova pagamento ou entrega.'});
  }
}
S.AsaasWebhookPayload = obj({id:str(200,5,{pattern:'^evt_[A-Za-z0-9_&-]{1,196}$'}),event:str(108,9,{pattern:'^PAYMENT_[A-Z0-9_]{1,100}$'}),account:obj({id:str(36,36,{format:'uuid'})},['id'],{additionalProperties:true}),payment:obj({id:str(104,5,{pattern:'^pay_[A-Za-z0-9]{1,100}$'}),externalReference:nullable(str(500)),billingType:str(100,1,{pattern:'^[A-Z_]{1,100}$'}),status:str(100,1,{pattern:'^[A-Z_]{1,100}$'}),value:{type:'number',minimum:0.01,maximum:9999999999.99,multipleOf:0.01}},['id','billingType','status','value'],{additionalProperties:true})},undefined,{additionalProperties:true,description:'JSON bruto UTF-8 até 256 KiB, não comprimido. Campos adicionais são aceitos em todos os níveis; só a pista sanitizada de conciliação é persistida. Conta deve coincidir com a configuração. Referências externas não JK ou não Pix são ignoradas após persistência.'});
S.AsaasWebhookReceipt = obj({received:{const:true},duplicate:bool,ignored:bool});
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
op('setInitialUserPassword','POST','/api/users/{userId}/initial-password',{roles:adminRoles,body:ref('SetInitialUserPasswordInput'),response:obj({user:ref('User')}),description:'Administrador define a primeira senha somente de conta pending inativa e ativa seu acesso. Exige CSRF e idempotência, sem version. Não redefine senha já existente.'});
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
  // Provider callbacks are documented separately: the user SDK deliberately has
  // no operation that would send this token through session-cookie transport.
  paths['/api/jk/integrations/asaas/webhook']={post:{operationId:'receiveAsaasWebhook',tags:['jk'],summary:'Receber notificação Asaas',
    description:'Entrada do provedor autenticada por asaas-access-token, sem sessão, CSRF ou Idempotency-Key. Responde 200 somente após persistência; deduplica por ambiente/conta/evento. Não quita ordens: a baixa depende de consulta autenticada explícita. Não é método do SDK de usuário.',
    security:[{asaasAccessToken:[]}],'x-roles':[],'x-idempotent-write':false,'x-body-max-bytes':262144,
    parameters:[{name:'asaas-access-token',in:'header',required:true,schema:str(255,32,{pattern:'^[!-~]+$',writeOnly:true}),description:'Token exclusivo do webhook, distinto da chave API e da sessão do usuário.'},{name:'Content-Encoding',in:'header',required:false,schema:en('identity'),description:'Não aceita corpo comprimido.'}],
    requestBody:{required:true,content:{'application/json':{schema:ref('AsaasWebhookPayload')}}},
    responses:{200:{description:'Pista guardada, duplicada ou ignorada; não confirma pagamento.',content:{'application/json':{schema:obj({ok:{const:true},data:ref('AsaasWebhookReceipt')})}}},default:{$ref:'#/components/responses/ApiError'}},
  }};
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'AB-UASH API', version: '0.5.0', description: 'Contrato HTTP operacional do servidor AB-UASH. A extensão de agenda pública está documentada separadamente em docs/integrations/booking-api.md. Dinheiro em centavos inteiros; quantidades de estoque em milésimos. A mesma API atende SQLite local e PostgreSQL. Sem tokens Supabase no cliente. Chamadas de mutação protegidas exigem Idempotency-Key, mas a API não promete processamento de pagamentos por terceiros.' },
    servers: [{ url: 'http://127.0.0.1:4173', description: 'Servidor local' }, { url: 'https://{host}', description: 'Servidor HTTPS implantado', variables: { host: { default: 'ab-uash.example.com', description: 'Host real da implantação; substitua o exemplo.' } } }],
    paths,
    components: {
      schemas,
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ab_uash_session', description: 'Sessão criada por setup/login. Navegadores usam credentials e não acessam o cookie HttpOnly.' },asaasAccessToken:{type:'apiKey',in:'header',name:'asaas-access-token',description:'Token exclusivo do webhook Asaas, 32–255 caracteres ASCII visíveis, conferido em tempo constante. Não é chave da API Asaas nem cookie de usuário.'} },
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
  if(schema===false)return 'never';
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
    const properties = Object.entries(schema.properties || {}).map(([name, property]) => `${property?.readOnly ? 'readonly ' : ''}${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${typeOf(property)}`);
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
