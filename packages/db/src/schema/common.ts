// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, foreignKey, pgPolicy, pgRole, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../id.js';
import { gyms } from './gyms.js';
const app = pgRole('app').existing();
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
