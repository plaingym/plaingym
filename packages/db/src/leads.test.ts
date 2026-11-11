// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { leads, leadContacts } from './schema/leads.js';
import { assertCatalog } from './security/catalog.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });

describe('lead storage boundaries', () => {
  it('passes the live forced-RLS and composite-reference catalog check', async () => {
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 62, tenantTableCount: 50 });
  });

  it.each([['leads', leads], ['leadContacts', leadContacts]] as const)('isolates reads and writes for %s', async (name, table) => {
    const row = await factory(name, gymB), byId = eq(table.id, row.id);
    expect(await database.forGym(gymB, tx => tx.select().from(table).where(byId))).toHaveLength(1);
    expect(await database.forGym(gymA, tx => tx.select().from(table).where(byId))).toEqual([]);
    expect(await database.app.db.select().from(table).where(byId)).toEqual([]);
    expect(await database.forSystem(tx => tx.select().from(table).where(byId))).toEqual([]);
    expect(await database.forGym(gymA, tx => tx.update(table).set({ createdAt: new Date(0) }).where(byId).returning())).toEqual([]);
    expect(await database.forGym(gymA, tx => tx.delete(table).where(byId).returning())).toEqual([]);
    await expect(database.forGym(gymA, tx => tx.insert(table).values({ ...row, id: uuidv7() })))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(database.app.db.insert(table).values({ ...row, id: uuidv7() }))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects cross-gym members and leads, and duplicate leads for a member', async () => {
    const foreign = await factory('leads', gymB);
    await expect(factory('leads', gymA, { memberId: foreign.memberId })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(factory('leadContacts', gymA, { leadId: foreign.id })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(factory('leads', gymB, { memberId: foreign.memberId })).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('lead field constraints', () => {
  it('defaults to a new, unattributed lead at revision one with no follow-up or history', async () => {
    expect(await factory('leads', gymA)).toMatchObject({ source: null, stage: 'new', revision: 1,
      lostReason: null, nextFollowUpOn: null, lastContactedAt: null, trialAttendedAt: null, wonAt: null, lostAt: null });
  });
  it.each(['trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other'])('accepts source %s', async source => {
    await factory('leads', gymA, { source });
  });
  it.each(['new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost'])('accepts stage %s with its timestamps', async stage => {
    await factory('leads', gymA, { stage, wonAt: new Date(), lostAt: new Date() });
  });
  it('accepts the text limits as Unicode characters, dates and each contact channel', async () => {
    const lead = await factory('leads', gymA, { lostReason: '😀'.repeat(500), nextFollowUpOn: '2026-11-15' });
    expect(lead.nextFollowUpOn).toBe('2026-11-15');
    for (const channel of ['call', 'text', 'email', 'in_person', 'other'])
      await factory('leadContacts', gymA, { leadId: lead.id, channel, note: '😀'.repeat(2000) });
    await factory('leadContacts', gymA, { leadId: lead.id, note: null });
  });
  it.each([{ source: 'website' }, { stage: 'pending' }, { stage: 'lost' }, { stage: 'won' },
    { lostReason: 'x'.repeat(501) }, { revision: 0 }, { revision: -1 }])('rejects invalid lead fields (%#)', async overrides => {
    await expect(factory('leads', gymA, overrides)).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it.each([{ channel: 'fax' }, { note: 'x'.repeat(2001) }])('rejects invalid contact fields (%#)', async overrides => {
    await expect(factory('leadContacts', gymA, overrides)).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
