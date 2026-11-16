// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, smsOutbox, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { outboxResponse } from '@plaingym/shared/contracts';
import { TestClock } from '../core/clock.js';
import { MemberSms, TwilioSms } from '../infra/sms/index.js';
import { createGymSettingsAccessor } from '../areas/settings/settings.js';
import { createSmsResolver, encryptSmsConfig } from '../areas/settings/sms.js';
import { createOutboxQuery } from './outbox.js';
import { smsSeed } from './seed/sms.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-16T04:00:00Z');
describe('demo SMS outbox', () => {
  it('captures MemberSms beside email without ever contacting a saved provider, and isolates list, detail and preview', async () => {
    const a = uuidv7(), b = uuidv7(), key = Buffer.alloc(32, 12);
    await factory('gyms', a, { name: 'Demo gym', memberSmsEnabled: true, address: { country: 'US' },
      smsConfig: encryptSmsConfig(key, a, { accountSid: 'AC' + '1'.repeat(32), auth: { token: 'demo-must-ignore' }, sender: { from: '+12025550111' } }) });
    await factory('gyms', b);
    const person = await factory('members', a, { phone: '+12025550110', phoneE164: '+12025550110',
      smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
    const provider = vi.spyOn(TwilioSms.prototype, 'sendSms').mockRejectedValue(new Error('Provider must not be called'));
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Network must not be called'));
    try {
      const resolver = createSmsResolver({ key, tenancy: 'multi', scope: db.forGym, demo: true, clock, fetch });
      const sms = new MemberSms({ gymId: a, memberIds: [person.id], householdIds: [], kind: 'notices', resolver,
        settings: createGymSettingsAccessor({ scope: db.forGym }), clock, scope: db.forGym });
      expect((await sms.sendSms({ to: '+12025550110', body: 'Class reminder' })).status).toBe('sent');
      expect(provider).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      await factory('emailOutbox', a, { subject: 'Email sample' });
      const other = await factory('smsOutbox', b, { recipient: '+12025550112', body: 'Private other gym' });
      const query = createOutboxQuery(db.forGym), all = outboxResponse.parse(await query.list(a, { limit: 100 }));
      expect(all.data.map(row => row.channel).sort()).toEqual(['email', 'sms']);
      const text = all.data.find(row => row.channel === 'sms')!;
      expect(text).toMatchObject({ recipient: '+12025550110', text: 'Demo gym: Class reminder' });
      expect(await query.get(a, text.id)).toEqual(text);
      await expect(query.preview(a, text.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(query.get(a, other.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(query.preview(a, other.id)).rejects.toMatchObject({ code: 'not_found' });
      expect(JSON.stringify(all)).not.toContain('Private other gym');
      const first = await query.list(a, { limit: 1 }), second = await query.list(a, { before: first.next!, limit: 1 });
      expect([first.data[0]!.id, second.data[0]!.id]).toEqual(all.data.map(row => row.id));
      expect(second.next).toBeNull();
    } finally { provider.mockRestore(); }
  });
  it('seeds fictional consenting members and captured texts once, without changing another gym', async () => {
    const a = uuidv7(), b = uuidv7(); await factory('gyms', a); await factory('gyms', b);
    for (let index = 0; index < 3; index++) await factory('members', a, { status: 'active', phone: '555-0110' });
    const seed = smsSeed({ scope: db.forGym, clock }), context = { gymId: a, timezone: 'UTC', enabledModules: new Set<string>() };
    await seed.run(context); await seed.run(context);
    const rows = await db.forGym(a, tx => tx.select().from(smsOutbox));
    expect(rows).toHaveLength(3); expect(rows.every(row => /^\+1202555011[0-2]$/.test(row.recipient))).toBe(true);
    expect((await createGymSettingsAccessor({ scope: db.forGym }).get(a)).memberSmsEnabled).toBe(true);
    expect((await createGymSettingsAccessor({ scope: db.forGym }).get(b)).memberSmsEnabled).toBe(false);
    expect(await db.forGym(b, tx => tx.select().from(smsOutbox))).toEqual([]);
    await db.forGym(a, tx => tx.update(gyms).set({ memberSmsEnabled: false }).where(eq(gyms.id, a)));
    await seed.run(context);
    expect((await createGymSettingsAccessor({ scope: db.forGym }).get(a)).memberSmsEnabled).toBe(false);
  });
});
