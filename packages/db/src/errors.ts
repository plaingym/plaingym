// SPDX-License-Identifier: AGPL-3.0-only
/** Driver and ORM failures can be plain objects; stop safely on a cyclic cause chain. */
export function* errorCauses(error: unknown): Generator<object> {
  const seen = new Set<object>();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    yield error;
    error = 'cause' in error ? error.cause : undefined;
  }
}

/** A database error's SQLSTATE code (`23503`, `23505`, …), found on the error or, as Drizzle wraps driver errors, on its causes. */
export function databaseCode(error: unknown): string | undefined {
  for (const cause of errorCauses(error))
    if ('code' in cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}
