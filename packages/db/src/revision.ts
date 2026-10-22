// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
export class RevisionConflictError extends Error {
  constructor() { super('The record changed since it was read'); this.name = 'RevisionConflictError'; }
}
/**
 * Compare-and-set for staff-editable rows. Callers send the revision they read;
 * the update matches only that revision and increments it in the same statement:
 *   const guard = revisionGuard(members.revision, expected);
 *   tx.update(members).set({ ...changes, revision: guard.next }).where(and(eq(members.id, id), guard.matches)).returning()
 */
export function revisionGuard(column: AnyPgColumn, expected: number): { matches: SQL; next: SQL } {
  return { matches: eq(column, expected), next: sql`${column} + 1` };
}
/** A stale save updates no row; route it to a conflict response (an absent row is the caller's 404). */
export function assertRevised<T>(rows: T[]): T {
  if (rows.length !== 1) throw new RevisionConflictError();
  return rows[0]!;
}
