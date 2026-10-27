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
      members: ['checkin_code_version', 'checkin_code_hash'],
      kiosk_devices: ['token_hash'],
      signed_links: ['token_hash'],
      payment_attempts: ['error'],
      audit_events: ['before', 'after'],
      email_outbox: ['subject', 'html', 'text'],
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
    // Operational run state has its own retention deadline; it is not a portable gym dataset.
    const runState = new Set(['import_runs', 'import_chunks', 'export_runs']);
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
