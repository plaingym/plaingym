// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test switches the sandbox gym's member settings in real PostgreSQL.
import { gyms, smsOutbox, uuidv7 } from '@plaingym/db';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;
const phone = '+12025550123';

it('texts a signed link to the household billing phone through the runtime composition, into the sandbox outbox', async () => {
  const sandbox = app.sandbox, gymId = sandbox.gymId;
  const headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin, 'content-type': 'application/json' };
  await database.forGym(gymId, tx => tx.update(gyms).set({ memberSmsEnabled: true }).where(eq(gyms.id, gymId)));
  const home = await factory('households', gymId, { email: null, phone, phoneE164: phone,
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  await factory('members', gymId, { householdId: home.id });
  const before = (await database.forGym(gymId, tx => tx.select().from(smsOutbox))).length;
  const body = { purpose: 'update_card', householdId: home.id, channel: 'sms', sendGeneration: uuidv7(),
    expiresAt: new Date(clock.now().getTime() + 86_400_000).toISOString() };
  const response = await app.runtime.app.request(`${sandbox.origin}/api/links/send`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
  const texts = (await database.forGym(gymId, tx => tx.select().from(smsOutbox))).slice(before);
  expect(texts).toHaveLength(1);
  expect(texts[0]!.recipient).toBe(phone);

  // The same generation replays the remembered result and texts nothing more.
  const replay = await app.runtime.app.request(`${sandbox.origin}/api/links/send`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await database.forGym(gymId, tx => tx.select().from(smsOutbox))).toHaveLength(before + 1);
});
