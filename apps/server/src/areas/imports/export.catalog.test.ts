// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encryptedFields, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
// eslint-disable-next-line database/system-tables -- Schema metadata only: compare the reviewed export projections with their Drizzle columns.
import { getTableColumns } from 'drizzle-orm';
import { exportDatasets } from '@plaingym/shared/contracts';
import { exportCatalog } from './export.catalog.js';
const root = new URL('../../../../../', import.meta.url);
const database = useTestDatabase(), factory = createFactories(database);
describe('export schema coverage and secret exclusions', () => {
  it('exports lead details and contact history only from the requested gym and cutoff', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), now = new Date('2026-11-10T12:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const lead = await factory('leads', gymA, { source: 'phone', stage: 'lost', lostAt: now, lostReason: 'No time',
      nextFollowUpOn: '2026-11-15', lastContactedAt: now, trialAttendedAt: now, wonAt: now });
    const contact = await factory('leadContacts', gymA, { leadId: lead.id, occurredAt: now, channel: 'call', note: 'Call next week' });
    await factory('leadContacts', gymB);
    const cutoff = new Date('2099-01-01T00:00:00Z');
    expect(await exportCatalog.leads.page(database.forGym, gymA, cutoff)).toEqual([{
      id: lead.id, gym_id: gymA, created_at: lead.createdAt, member_id: lead.memberId, source: 'phone', stage: 'lost',
      lost_reason: 'No time', next_follow_up_on: '2026-11-15', last_contacted_at: now, trial_attended_at: now,
      won_at: now, lost_at: now, revision: 1,
    }]);
    expect(await exportCatalog.lead_contacts.page(database.forGym, gymA, cutoff)).toEqual([{
      id: contact.id, gym_id: gymA, created_at: contact.createdAt, lead_id: lead.id, occurred_at: now,
      channel: 'call', note: 'Call next week', created_by: contact.createdBy,
    }]);
    for (const name of ['leads', 'lead_contacts'] as const)
      expect(await exportCatalog[name].page(database.forGym, gymA, new Date(0))).toEqual([]);
  });
  it('exports all four pack datasets and member credit history only for the requested gym', async () => {
    const gymA = uuidv7(), gymB = uuidv7();
    await factory('gyms', gymA); await factory('gyms', gymB);
    for (const [table, name] of [['classPacks', 'class_packs'], ['classPackTaxRates', 'class_pack_tax_rates'],
      ['classPackSales', 'class_pack_sales'], ['classCreditEntries', 'class_credit_entries']] as const) {
      const own = await factory(table, gymA), foreign = await factory(table, gymB);
      const rows = await exportCatalog[name].page(database.forGym, gymA, new Date('2099-01-01T00:00:00Z'));
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: own.id, gym_id: gymA })]));
      expect(rows.some(row => row.id === foreign.id || row.gym_id !== gymA)).toBe(false);
      expect(await exportCatalog[name].page(database.forGym, gymA, new Date(0))).toEqual([]);
    }
    const [entry] = await exportCatalog.class_credit_entries.page(database.forGym, gymA, new Date('2099-01-01T00:00:00Z'));
    expect(entry).toMatchObject({ kind: 'adjust', credits: 10, reason: 'Test adjustment', member_id: expect.any(String), adjustment_id: expect.any(String) });
  });
  it('exports announcement history and member consent only for the requested gym', async () => {
    const gymA = uuidv7(), gymB = uuidv7();
    await factory('gyms', gymA); await factory('gyms', gymB);
    const announcement = await factory('announcements', gymA);
    const optOut = await factory('announcementOptOuts', gymA);
    await factory('announcementRecipients', gymA, { announcementId: announcement.id });
    await factory('announcements', gymB); await factory('announcementOptOuts', gymB);
    const cutoff = new Date('2099-01-01T00:00:00Z');
    expect(await exportCatalog.announcements.page(database.forGym, gymA, cutoff)).toEqual([{
      id: announcement.id, gym_id: gymA, created_at: announcement.createdAt, created_by: announcement.createdBy,
      subject: announcement.subject, body: announcement.body, audience: announcement.audience,
      recipient_count: announcement.recipientCount, status: announcement.status, completed_at: announcement.completedAt,
    }]);
    expect(await exportCatalog.announcement_opt_outs.page(database.forGym, gymA, cutoff)).toEqual([{
      id: optOut.id, gym_id: gymA, created_at: optOut.createdAt, member_id: optOut.memberId,
    }]);
    expect(await exportCatalog.announcements.page(database.forGym, gymA, new Date(0))).toEqual([]);
    expect(exportDatasets).not.toContain('announcement_recipients');
  });
  it('exports both waiver formats and retired PDF references only for the requested gym', async () => {
    const gymA = uuidv7(), gymB = uuidv7();
    await factory('gyms', gymA); await factory('gyms', gymB);
    const document = { documentKey: `${gymA}/waivers/templates/${uuidv7()}.pdf`, documentHash: 'a'.repeat(64), documentPages: 2, documentBytes: 1024 };
    const text = await factory('waiverTemplates', gymA, { body: 'Original text terms.' });
    const pdf = await factory('waiverTemplates', gymA, { body: '', ...document, retiredAt: new Date('2026-11-01T00:00:00Z') });
    await factory('waiverTemplates', gymB, { body: '', ...document, documentKey: `${gymB}/waivers/templates/${uuidv7()}.pdf` });
    const rows = await exportCatalog.waiver_templates.page(database.forGym, gymA, new Date('2099-01-01T00:00:00Z'));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: text.id, body: text.body, document_key: null, document_hash: null, document_pages: null, document_bytes: null }),
      expect.objectContaining({ id: pdf.id, body: '', document_key: document.documentKey, document_hash: document.documentHash,
        document_pages: document.documentPages, document_bytes: document.documentBytes, retired_at: pdf.retiredAt }),
    ]));
  });
  it('exports annual anniversaries and processor timestamps from PostgreSQL only for the requested gym', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), processorCreatedAt = new Date('2026-10-01T12:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const membership = await factory('memberships', gymA, { interval: 'annual', startsOn: '2024-02-29', anniversaryOn: '2024-02-29' });
    const card = await factory('paymentMethods', gymA, { processorCreatedAt });
    await factory('memberships', gymB); await factory('paymentMethods', gymB);
    const cutoff = new Date('2099-01-01T00:00:00Z');
    expect(await exportCatalog.memberships.page(database.forGym, gymA, cutoff)).toEqual([
      expect.objectContaining({ id: membership.id, anniversary_on: '2024-02-29' }),
    ]);
    expect(await exportCatalog.payment_methods.page(database.forGym, gymA, cutoff)).toEqual([
      expect.objectContaining({ id: card.id, processor_created_at: processorCreatedAt }),
    ]);
  });
  it('accounts for every schema column with an explicit safe projection or exclusion', () => {
    const excluded: Partial<Record<keyof typeof exportCatalog, readonly string[]>> = {
      households: ['pin_hash'],
      // The folded lookup values are generated from last_name and email, which are already exported.
      members: ['checkin_code_version', 'checkin_code_hash', 'last_name_folded', 'email_folded'],
      kiosk_devices: ['token_hash'],
      signed_links: ['token_hash'],
      payment_attempts: ['error'],
      audit_events: ['before', 'after'],
      email_outbox: ['subject', 'html', 'text'],
      // A client's send idempotency generation is install-local delivery state, not portable announcement history.
      announcements: ['send_generation'],
    };
    for (const name of Object.keys(exportCatalog) as (keyof typeof exportCatalog)[]) {
      const dataset = exportCatalog[name], omitted = excluded[name] ?? [];
      const schema = Object.values(getTableColumns(dataset.table));
      expect(Object.keys(dataset.columns).sort(), name).toEqual(schema.map(column => column.name).filter(column => !omitted.includes(column)).sort());
      for (const column of omitted) expect(schema.some(field => field.name === column), name + '.' + column).toBe(true);
      for (const [key, column] of Object.entries(dataset.columns)) {
        expect(key).toBe(column.name);
        expect(schema).toContain(column);
      }
    }
  });
  it('covers every domain table and every contract dataset exactly once', () => {
    const schemaRoot = new URL('packages/db/src/schema/', root);
    const systemSource = readFileSync(new URL('packages/db/system-tables.mjs', root), 'utf8');
    const systemNames = new Set([...systemSource.matchAll(/"name": "([^"]+)"/g)].map((match) => match[1]));
    const tableNames = readdirSync(schemaRoot).filter((file) => file.endsWith('.ts')).flatMap((file) =>
      [...readFileSync(new URL(file, schemaRoot), 'utf8').matchAll(/pgTable\(['"]([^'"]+)['"]/g)].map((match) => match[1]!));
    expect(tableNames.length).toBeGreaterThan(exportDatasets.length);
    // Operational run state has its own retention deadline; it is not a portable gym dataset. Email send state
    // only guards this install's job keys against resending.
    const runState = new Set(['import_runs', 'import_chunks', 'export_runs', 'email_deliveries', 'announcement_recipients']);
    expect(tableNames.filter((name) => !systemNames.has(name) && !runState.has(name)).sort()).toEqual(Object.keys(exportCatalog).sort());
    expect(Object.keys(exportCatalog).sort()).toEqual([...exportDatasets].sort());
  });
  it('never selects an encrypted field, credential hash, opaque audit payload or email body', () => {
    for (const [name, dataset] of Object.entries(exportCatalog)) {
      expect(name).not.toMatch(/^auth_|^(gyms|gym_domains|jobs|backup_runs|stripe_events)$/);
      for (const column of Object.values(dataset.columns)) {
        expect(encryptedFields.some((field) => field.table === name && field.column === column.name)).toBe(false);
        expect(column.name).not.toMatch(/encrypted|password|pin_hash|token_hash|checkin_code/);
      }
    }
    expect(Object.keys(exportCatalog.audit_events.columns)).not.toEqual(expect.arrayContaining(['before', 'after']));
    expect(Object.keys(exportCatalog.email_outbox.columns)).not.toEqual(expect.arrayContaining(['html', 'text']));
  });
  it('keeps the occurrence key, so a moved class session stays distinct from its original date', () => {
    expect(exportCatalog.class_sessions.columns).toHaveProperty('occurrence_starts_at.name', 'occurrence_starts_at');
  });
});
