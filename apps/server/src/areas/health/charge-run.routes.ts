// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { healthContracts } from '@plaingym/shared/contracts';
import { route, type RouteRegistration } from '../../core/registry.js';
import type { ChargeRunner } from '../billing/runner/index.js';

type FailureRunner = Pick<ChargeRunner, 'chargeFailures' | 'dismissChargeFailures'>;
let configured: FailureRunner | undefined;
/** The runtime passes the charge runner whose reports the charge-run tile lists. */
export function configureChargeFailures(runner: FailureRunner) { configured = runner; }
export function createChargeFailureRoutes(runner?: FailureRunner): readonly RouteRegistration[] {
  const read = () => {
    const found = runner ?? configured;
    if (!found) throw new AppError('unavailable', 'Charge failure reports are not available');
    return found;
  };
  const list = healthContracts.listChargeFailures, dismiss = healthContracts.dismissChargeFailures;
  return [
    route({ ...list, responses: { 200: { description: 'Open charge failure reports', content: { 'application/json': { schema: list.response } } } } }, async (c) => {
      const context = c.get('context'), principal = context.principal;
      if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
      const reports = await read().chargeFailures(context.gym.gymId);
      c.header('Cache-Control', 'no-store');
      return c.json({ data: reports.map(report => ({ runId: report.runId, day: report.day, reportedAt: report.reportedAt.toISOString(),
        failures: report.failures.map(({ invoiceId, number, cause }) => ({ invoiceId, number, cause })) })) }, 200);
    }),
    route({ ...dismiss, request: { body: { required: true, content: { 'application/json': { schema: dismiss.body } } } },
      responses: { 200: { description: 'Dismissed invoices', content: { 'application/json': { schema: dismiss.response } } } } }, async (c) => {
      const context = c.get('context'), principal = context.principal;
      if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Gym not found');
      const { runId } = c.req.valid('json');
      const result = await read().dismissChargeFailures({ gymId: context.gym.gymId, actor: { kind: 'user', userId: principal.userId } }, runId);
      c.header('Cache-Control', 'no-store');
      return c.json({ data: { dismissed: result.dismissed } }, 200);
    }),
  ];
}
export const routes = createChargeFailureRoutes();
