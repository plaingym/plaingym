// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgPolicy, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { app } from './access.js';
import { uuidv7 } from '../id.js';
import { gyms } from './gyms.js';
export const instant = (name: string) => timestamp(name, { withTimezone: true });
export const base = () => ({
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  gymId: uuid('gym_id').notNull().references(() => gyms.id, { onDelete: 'cascade' }),
  createdAt: instant('created_at').notNull().defaultNow(),
});
export function scoped(name: string, table: { gymId: AnyPgColumn; id: AnyPgColumn }) {
  const predicate = sql`${table.gymId} = nullif(current_setting('app.gym_id', true), '')::uuid`;
  return [
    unique(name + '_gym_id_id_key').on(table.gymId, table.id),
    pgPolicy(name + '_gym_policy', { to: app, for: 'all', using: predicate, withCheck: predicate }),
  ];
}
export const ref = (name: string, gymId: AnyPgColumn, column: AnyPgColumn, target: { gymId: AnyPgColumn; id: AnyPgColumn }) =>
  foreignKey({ name, columns: [gymId, column], foreignColumns: [target.gymId, target.id] });
export const choice = (name: string, column: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.join(values.map((value) => sql.raw("'" + value.replaceAll("'", "''") + "'")), sql`, `)})`);
export const currencyCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} ~ '^[A-Z]{3}$'`);
/** Lowercase SHA-256 hex; nullable columns pass when null. */
export const sha256Check = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} ~ '^[a-f0-9]{64}$'`);
/** Staff-editable rows carry a revision for compare-and-set updates (see revision.ts). */
export const revision = () => ({ revision: integer('revision').notNull().default(1) });
export const revisionCheck = (name: string, column: AnyPgColumn) => check(name, sql`${column} > 0`);
/** Amounts must use the gym's single billing currency, which is locked once referenced. */
export const gymCurrency = (name: string, table: { gymId: AnyPgColumn; currency: AnyPgColumn }) =>
  foreignKey({ name, columns: [table.gymId, table.currency], foreignColumns: [gyms.id, gyms.currency] }).onDelete('cascade');
