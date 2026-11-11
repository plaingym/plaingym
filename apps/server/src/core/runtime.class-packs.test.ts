// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test counts queued effect jobs in real PostgreSQL.
import { classCreditEntries, invoices, jobs, uuidv7 } from '@plaingym/db';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;

it('publishes a zero-total pack sale through the runtime transitions, so its credits are granted from the queued effect', async () => {
  const sandbox = app.sandbox, cookie = await app.login('owner');
  const headers = { ...app.headers(sandbox, cookie), origin: sandbox.origin, 'content-type': 'application/json' };
  const pack = await factory('classPacks', sandbox.gymId, { credits: 10, amountCents: 0, expiryDays: 30 });
  const member = await factory('members', sandbox.gymId);
  const effects = () => database.forSystem(tx => tx.select().from(jobs).where(and(eq(jobs.gymId, sandbox.gymId), eq(jobs.name, 'billing.transitions.effect'))));
  const before = (await effects()).length;

  const sold = await app.runtime.app.request(sandbox.origin + '/api/billing/packs/' + pack.id + '/sell', { method: 'POST', headers,
    body: JSON.stringify({ memberId: member.id, dueOn: clock.now().toISOString().slice(0, 10) }) });
  expect(sold.status, await sold.clone().text()).toBeLessThan(300);
  const { data } = await sold.json() as { data: { id: string; status: string } };
  expect(data.status).toBe('paid');
  expect((await database.forGym(sandbox.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, data.id))))[0]!.status).toBe('paid');

  // Only the runtime's publishing transitions queue the effect job at once; the default service leaves it for the hourly sweep.
  const queued = await effects();
  expect(queued.length).toBeGreaterThan(before);
  const handler = app.handlers.get('billing.transitions.effect');
  expect(handler).toBeDefined();
  for (const job of queued) await handler!((job.payload as { value: unknown }).value, { gymId: sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });

  const grants = (await database.forGym(sandbox.gymId, tx => tx.select().from(classCreditEntries))).filter(entry => entry.memberId === member.id);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ kind: 'grant', credits: 10 });
});
