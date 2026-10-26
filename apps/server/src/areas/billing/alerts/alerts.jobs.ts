// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { sendAlertJob, type BillingAlerts } from './index.js';

let configured: BillingAlerts | undefined;
export function configureBillingAlerts(alerts: BillingAlerts) { configured = alerts; }
export function createBillingAlertJobs(read: () => BillingAlerts | undefined = () => configured): readonly JobRegistration[] {
  function service() {
    const alerts = read();
    if (!alerts) throw new Error('Billing alerts are not configured');
    return alerts;
  }
  return [
    { id: 'billing.alerts.card_expiry', cron: '0 9 * * *', async handler(_payload, context) {
      await service().cardExpiry(context.gymId);
    } },
    { id: 'billing.alerts.disputes', cron: '41 * * * *', async handler(_payload, context) {
      await service().disputes(context.gymId);
    } },
    { id: sendAlertJob, async handler(payload, context) { await service().send(payload, context); } },
  ];
}
export const jobs = createBillingAlertJobs();
