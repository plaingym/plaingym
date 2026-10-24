// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structured JSON log lines on stderr, one object per line. Callers pass identifiers and classifications only:
 * never credentials, cookies, signed URLs or link paths, request bodies, or personal data.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
type Sink = (line: string) => void;
let sink: Sink = (line) => { process.stderr.write(line + '\n'); };
/** Tests capture log lines; returns the previous sink. */
export function setLogSink(next: Sink): Sink { const previous = sink; sink = next; return previous; }

export function logError(event: string, fields: LogFields, error?: unknown): void {
  sink(JSON.stringify({ time: new Date().toISOString(), level: 'error', event, ...fields,
    ...(error === undefined ? {} : { error: describeError(error) }) }));
}
const identifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/**
 * What an error says that is safe to log: its name, code, and stack frames, plus its cause. Messages can quote
 * submitted values, credentials, or personal data, so none is logged as written. Two shapes are known safe:
 * a Postgres error's schema identifiers (never its message, which can quote a value), and a query error's
 * SQL text, whose values are placeholders (`$1`) with the bound parameters on later lines, which are dropped.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const fields = error as unknown as Record<string, unknown>;
  const frames = (error.stack ?? '').split(/\r?\n/).filter((line) => line.trim().startsWith('at ')).slice(0, 15).map((line) => line.trim());
  const schema = Object.fromEntries((['table_name', 'column_name', 'constraint_name', 'routine'] as const)
    .flatMap((key) => typeof fields[key] === 'string' && identifier.test(fields[key]) ? [[key, fields[key]]] : []));
  const query = /^Failed query: (.*)$/.exec(error.message.split(/\r?\n/)[0] ?? '')?.[1];
  return { name: error.name, ...(typeof fields.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(fields.code) ? { code: fields.code } : {}),
    ...schema, ...(query ? { query: query.slice(0, 500) } : {}), frames,
    ...(error.cause !== undefined && depth < 2 ? { cause: describeError(error.cause, depth + 1) } : {}) };
}
