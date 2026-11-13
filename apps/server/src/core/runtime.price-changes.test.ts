// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test switches the sandbox gym's member-email setting in real PostgreSQL.
import { gyms, plans } from '@plaingym/db';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;

it('serves the plan price change preview through the runtime composition, which tells it the sandbox gym can send member email', async () => {
  const sandbox = app.sandbox, headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin };
  const [plan] = await database.forGym(sandbox.gymId, tx => tx.select().from(plans).limit(1));
  expect(plan).toBeDefined();
  await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  const effectiveOn = new Date(clock.now().getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const response = await app.runtime.app.request(
    `${sandbox.origin}/api/billing/plans/${plan!.id}/price-change?amountCents=${plan!.amountCents + 500}&effectiveOn=${effectiveOn}`, { headers });
  expect(response.status, await response.clone().text()).toBe(200);
  const { data } = await response.json() as { data: { canEmail: boolean; plan: { id: string } } };
  expect(data.plan.id).toBe(plan!.id);
  // The service is configured with the runtime's SMTP check, which counts the demo outbox as configured.
  expect(data.canEmail).toBe(true);
});
