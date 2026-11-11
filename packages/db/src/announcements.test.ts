// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { announcementOptOuts, announcementRecipients, announcements } from './schema/announcements.js';
import { assertCatalog } from './security/catalog.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });

describe('announcement storage boundaries', () => {
  it('declares forced gym policies and scoped references in the live catalog', async () => {
    expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 62, tenantTableCount: 50 });
  });

  it.each([
    ['announcements', announcements],
    ['announcementRecipients', announcementRecipients],
    ['announcementOptOuts', announcementOptOuts],
  ] as const)('isolates reads, inserts, updates and deletes for %s', async (name, table) => {
    const row = await factory(name, gymB);
    const byId = eq(table.id, row.id);
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

  it('refuses cross-gym announcement and member references', async () => {
    const foreignAnnouncement = await factory('announcements', gymB);
    const foreignMember = await factory('members', gymB);
    await expect(factory('announcementRecipients', gymA, { announcementId: foreignAnnouncement.id }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(factory('announcementRecipients', gymA, { memberId: foreignMember.id }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(factory('announcementOptOuts', gymA, { memberId: foreignMember.id }))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('deduplicates recipients per announcement and consent per member', async () => {
    const recipient = await factory('announcementRecipients', gymA);
    await expect(factory('announcementRecipients', gymA, { announcementId: recipient.announcementId, memberId: recipient.memberId }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
    await factory('announcementRecipients', gymA, { memberId: recipient.memberId });
    await factory('announcementOptOuts', gymA, { memberId: recipient.memberId });
    await expect(factory('announcementOptOuts', gymA, { memberId: recipient.memberId }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('announcement constraints', () => {
  it('accepts the subject/body limits and both lifecycle states', async () => {
    await factory('announcements', gymA, { subject: 'a'.repeat(150), body: 'b'.repeat(10000) });
    await factory('announcements', gymA, { subject: '😀'.repeat(150), status: 'sent', completedAt: new Date() });
  });

  it.each([
    { subject: '' }, { subject: 'a'.repeat(151) }, { body: '' }, { body: 'b'.repeat(10001) },
    { recipientCount: -1 }, { status: 'draft' },
    { status: 'sent', completedAt: null }, { status: 'sending', completedAt: new Date() },
    { audience: {} }, { audience: { statuses: null, programIds: [] } },
    { audience: { statuses: [], programIds: 'all' } },
  ])('rejects invalid announcement fields (%#)', async (overrides) => {
    await expect(factory('announcements', gymA, overrides as Partial<typeof announcements.$inferInsert>))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it.each(['pending', 'sent', 'failed', 'skipped'])('accepts recipient state %s with its matching reason', async state => {
    await factory('announcementRecipients', gymA, { state, reason: ['failed', 'skipped'].includes(state) ? 'unknown' : null });
  });

  it.each(['pending', 'sent', 'failed', 'skipped'])('rejects recipient state %s with a mismatched reason', async state => {
    await expect(factory('announcementRecipients', gymA, { state, reason: ['failed', 'skipped'].includes(state) ? null : 'unknown' }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('uniquely scopes generations to the gym', async () => {
    const sendGeneration = uuidv7();
    await factory('announcements', gymA, { sendGeneration });
    await factory('announcements', gymB, { sendGeneration });
    await expect(factory('announcements', gymA, { sendGeneration })).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it.each(['opt_out', 'undeliverable', 'disabled', 'anonymized', 'ineligible', 'missing_email',
    'duplicate_address', 'not_accepted', 'unknown'])('accepts safe recipient reason %s', async reason => {
    await factory('announcementRecipients', gymA, { state: 'skipped', reason });
  });

  it('rejects unknown states and free-form delivery reasons', async () => {
    await expect(factory('announcementRecipients', gymA, { state: 'retrying' }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(factory('announcementRecipients', gymA, { reason: 'SMTP response with private recipient details' }))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
