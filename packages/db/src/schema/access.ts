// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole, type AnyPgColumn } from 'drizzle-orm/pg-core';
// Kept free of table imports: common.ts and gyms.ts both use it.
export const app = pgRole('app').existing();
/** Transaction-local gym context set by forGym; unset or reset context matches nothing. */
export const gymContext = (column: AnyPgColumn) => sql`${column} = nullif(current_setting('app.gym_id', true), '')::uuid`;
/** System context: set by forSystem for one transaction, or for the whole connection by the auth pool. */
export const systemContext = sql`current_setting('app.system', true) = 'on'`;
/** How a system table is reached; system-tables.mjs declares each table's kind and the catalog check verifies it. */
export type SystemAccess = 'gym' | 'gym-config' | 'system';
/**
 * System tables keep forced RLS too. Gym context sees only its own gym's rows (never another gym's,
 * never install-level rows); infrastructure reaches the rest through system context. No context sees nothing.
 */
export function systemAccess(name: string, access: SystemAccess, column?: AnyPgColumn) {
  if (access === 'system') {
    return [pgPolicy(name + '_system_policy', { to: app, for: 'all', using: systemContext, withCheck: systemContext })];
  }
  if (!column) throw new Error('Gym-scoped system access needs its gym column');
  const scoped = sql`(${gymContext(column)}) or (${systemContext})`;
  if (access === 'gym') return [pgPolicy(name + '_gym_policy', { to: app, for: 'all', using: scoped, withCheck: scoped })];
  // A gym reads and updates its own configuration; only infrastructure creates or deletes gyms.
  return [
    pgPolicy(name + '_read_policy', { to: app, for: 'select', using: scoped }),
    pgPolicy(name + '_update_policy', { to: app, for: 'update', using: scoped, withCheck: scoped }),
    pgPolicy(name + '_insert_policy', { to: app, for: 'insert', withCheck: systemContext }),
    pgPolicy(name + '_delete_policy', { to: app, for: 'delete', using: systemContext }),
  ];
}
