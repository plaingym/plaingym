// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { healthContracts, exhaustedEffectsResponseSchema } from '@plaingym/shared/contracts';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';
import { clock } from './clock.js';
import { effectJob, effectRecoveryExhausted, effectStaffRetried, effectDismissed } from '../areas/billing/transitions/effects.js';
import { effectCreated, effectPublished, effectCompleted } from '../areas/billing/transitions/store.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;
it('wires the runtime Health list, Retry, Dismiss and effect handler to the same billing service', async () => {
  const { sandbox } = app, gymId = sandbox.gymId, cookie = await app.login('owner');
  const home = await factory('households', gymId), bill = await factory('invoices', gymId, { householdId: home.id, status: 'paid', number: 900001, paidAt: clock.now() });
  const retryId = uuidv7(), dismissId = uuidv7();
  for (const id of [retryId, dismissId]) {
    for (const action of [effectCreated, effectPublished, effectRecoveryExhausted]) await factory('auditEvents', gymId,
      { action, targetType: 'invoice_effect', targetId: id, after: { invoiceId: bill.id, kind: 'activate_memberships' } });
  }
  const get = () => app.runtime.app.request(sandbox.origin + healthContracts.listEffectFailures.path, { headers: app.headers(sandbox, cookie) });
  expect(exhaustedEffectsResponseSchema.parse(await (await get()).json()).data.map(row => row.effectId).sort()).toEqual([retryId, dismissId].sort());
  const retry = await app.post(healthContracts.retryEffect.path, { effectId: retryId }, sandbox.origin, { cookie });
  expect(retry.status, await retry.clone().text()).toBe(200);
  const handler = app.handlers.get(effectJob)!;
  await handler({ effectId: retryId }, { gymId, jobId: uuidv7(), timezone: 'UTC', attempt: 1, clock });
  const dismiss = await app.post(healthContracts.dismissEffect.path, { effectId: dismissId }, sandbox.origin, { cookie });
  expect(dismiss.status, await dismiss.clone().text()).toBe(200);
  expect(exhaustedEffectsResponseSchema.parse(await (await get()).json()).data).toEqual([]);
  const audits = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, retryId)));
  expect(audits.map(row => row.action)).toContain(effectStaffRetried);
  expect(audits.map(row => row.action)).toContain(effectCompleted);
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, dismissId))))
    .toEqual(expect.arrayContaining([expect.objectContaining({ action: effectDismissed, actorKind: 'user' })]));
});
