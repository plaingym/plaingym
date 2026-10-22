// SPDX-License-Identifier: AGPL-3.0-only
import type { Sql } from '../client.js';
/** Restricted columns remain immutable for app, even through raw SQL. */
export const mutableAttemptColumns = ['payment_intent_id', 'status', 'decline_code', 'error', 'resolved_at'] as const;
export const appendOnlyTables = ['audit_events', 'waiver_signatures'] as const;
/** Reviewed security SQL: idempotent and deliberately never blanket-grants table access. */
export async function applySecurity(sql: Sql) {
  await sql.begin(async (tx) => {
    const tables = await tx`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    `;
    for (const table of tables) await tx`alter table public.${tx(table.relname)} force row level security`;
    for (const table of appendOnlyTables) await tx`revoke update, delete on table public.${tx(table)} from app`;
    await tx`revoke update, delete on table public.payment_attempts from app`;
    for (const table of [...appendOnlyTables, 'payment_attempts']) {
      const columns = await tx`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
      await tx`revoke update (${tx(columns.map((column) => column.column_name))}) on public.${tx(table)} from app`;
    }
    await tx`grant update (${tx([...mutableAttemptColumns])}) on public.payment_attempts to app`;
  });
}
