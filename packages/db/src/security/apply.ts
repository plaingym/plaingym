// SPDX-License-Identifier: AGPL-3.0-only
import type { Sql } from '../client.js';
/** Restricted columns remain immutable for app, even through raw SQL. */
export const mutableColumns: Readonly<Record<string, readonly string[]>> = {
  payment_attempts: ['payment_intent_id', 'status', 'decline_code', 'error', 'resolved_at'],
  class_credit_entries: ['reason'],
};
export const appendOnlyTables = ['audit_events', 'waiver_signatures', 'class_credit_entries'] as const;
/** Append-only rows the app may still delete: a signed waiver is never edited, but it is deleted
 * (and audited) when a member's personal data is erased on request. */
export const deletableAppendOnlyTables = ['waiver_signatures'] as const;
/** Reviewed security SQL: idempotent and deliberately never blanket-grants table access. */
export async function applySecurity(sql: Sql) {
  await sql.begin(async (tx) => {
    const tables = await tx`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    `;
    // Historical upgrade fixtures run this step before the ledger migration exists.
    // The current-schema catalog check still requires the table at application startup.
    const existing = new Set(tables.map(table => table.relname));
    const immutableTables = appendOnlyTables.filter(table => existing.has(table));
    const restrictedTables = [...new Set([...immutableTables, ...Object.keys(mutableColumns).filter(table => existing.has(table))])];
    for (const table of tables) await tx`alter table public.${tx(table.relname)} force row level security`;
    for (const table of restrictedTables) {
      await tx`revoke update, delete on table public.${tx(table)} from app`;
      const columns = await tx`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
      await tx`revoke update (${tx(columns.map((column) => column.column_name))}) on public.${tx(table)} from app`;
    }
    for (const table of deletableAppendOnlyTables) {
      if (existing.has(table)) await tx`grant delete on table public.${tx(table)} to app`;
    }
    for (const [table, columns] of Object.entries(mutableColumns)) {
      if (existing.has(table)) await tx`grant update (${tx([...columns])}) on public.${tx(table)} to app`;
    }
  });
}
