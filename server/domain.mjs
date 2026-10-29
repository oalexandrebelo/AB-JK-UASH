import { masterRoutes } from './domain-core.mjs';
import { orderRoutes, appointmentRoutes } from './domain-orders.mjs';
import { stockRoutes, cashRoutes, invoiceRoutes, packageRoutes, paymentRoutes } from './domain-finance.mjs';
import { payrollRoutes, messageRoutes, settingsRoutes } from './domain-office.mjs';
import { dashboardRoutes, reportRoutes } from './domain-reports.mjs';

const routes = [masterRoutes, orderRoutes, appointmentRoutes, stockRoutes, cashRoutes, invoiceRoutes, packageRoutes, paymentRoutes, payrollRoutes, messageRoutes, settingsRoutes, dashboardRoutes, reportRoutes];

export async function handleDomain(context) {
  for (const route of routes) {
    const response = await route(context);
    if (response) return response;
  }
  return null;
}
