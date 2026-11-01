// SPDX-License-Identifier: AGPL-3.0-only
/** A database error's SQLSTATE code (`23503`, `23505`, …), found on the error or, as Drizzle wraps driver errors, on its causes. */
export function databaseCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return databaseCode(error.cause);
}
