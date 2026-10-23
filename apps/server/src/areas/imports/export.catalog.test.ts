// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encryptedFields } from '@plaingym/db';
import { exportDatasets } from '@plaingym/shared/contracts';
import { exportCatalog } from './export.catalog.js';
const root = new URL('../../../../../', import.meta.url);
describe('export schema coverage and secret exclusions', () => {
  it('covers every non-system schema table and every contract dataset exactly once', () => {
    const schemaRoot = new URL('packages/db/src/schema/', root);
    const systemSource = readFileSync(new URL('packages/db/system-tables.mjs', root), 'utf8');
    const systemNames = new Set([...systemSource.matchAll(/"name": "([^"]+)"/g)].map((match) => match[1]));
    const tableNames = readdirSync(schemaRoot).filter((file) => file.endsWith('.ts')).flatMap((file) =>
      [...readFileSync(new URL(file, schemaRoot), 'utf8').matchAll(/pgTable\(['"]([^'"]+)['"]/g)].map((match) => match[1]!));
    expect(tableNames.length).toBeGreaterThan(exportDatasets.length);
    expect(tableNames.filter((name) => !systemNames.has(name)).sort()).toEqual(Object.keys(exportCatalog).sort());
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
