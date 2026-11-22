// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structured JSON log lines on stderr, one object per line. Callers pass identifiers and classifications only:
 * never credentials, cookies, signed URLs or link paths, request bodies, or personal data.
 */
// eslint-disable-next-line database/system-tables -- The query error class only recognizes errors Drizzle raised; it builds no SQL and names no table.
import { DrizzleQueryError } from 'drizzle-orm/errors';
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
type Sink = (line: string) => void;
let sink: Sink = (line) => { process.stderr.write(line + '\n'); };
/** Tests capture log lines; returns the previous sink. */
export function setLogSink(next: Sink): Sink { const previous = sink; sink = next; return previous; }

export function logInfo(event: string, fields: LogFields): void {
  sink(JSON.stringify({ time: new Date().toISOString(), level: 'info', event, ...fields }));
}

export function logWarn(event: string, fields: LogFields): void {
  sink(JSON.stringify({ time: new Date().toISOString(), level: 'warn', event, ...fields }));
}

export function logError(event: string, fields: LogFields, error?: unknown): void {
  sink(JSON.stringify({ time: new Date().toISOString(), level: 'error', event, ...fields,
    ...(error === undefined ? {} : { error: describeError(error) }) }));
}
const identifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/**
 * The stack frames after the stack's exact `name: message` header (`name` alone for an empty message), so no
 * line of a multiline message passes for a frame. A stack that doesn't start with that header gives none. Only
 * lines starting `    at ` count; at most 15 are kept, trimmed. Every log path that records frames uses this.
 */
export function stackFrames(error: Error): string[] {
  if (typeof error.stack !== 'string') return [];
  const header = error.message === '' ? `${error.name}\n` : `${error.name}: ${error.message}\n`;
  if (!error.stack.startsWith(header)) return [];
  return error.stack.slice(header.length).split(/\r?\n/).filter((line) => line.startsWith('    at ')).slice(0, 15).map((line) => line.trim());
}
/**
 * What an error says that is safe to log: its name, code, and stack frames, plus its cause. Messages can quote
 * submitted values, credentials, or personal data, so none is logged as written. Two shapes are known safe:
 * a Postgres error's schema identifiers (never its message, which can quote a value), and the SQL text of a
 * query error Drizzle raised, whose values are placeholders (`$1`) with the bound parameters on later lines,
 * which are dropped. Any other error whose message starts the same way is only a message.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const fields = error as unknown as Record<string, unknown>;
  const frames = stackFrames(error);
  const schema = Object.fromEntries((['table_name', 'column_name', 'constraint_name', 'routine'] as const)
    .flatMap((key) => typeof fields[key] === 'string' && identifier.test(fields[key]) ? [[key, fields[key]]] : []));
  const query = error instanceof DrizzleQueryError ? /^Failed query: (.*)$/.exec(error.message.split(/\r?\n/)[0] ?? '')?.[1] : undefined;
  return { name: error.name, ...(typeof fields.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(fields.code) ? { code: fields.code } : {}),
    ...schema, ...(query ? { query: query.slice(0, 500) } : {}), frames,
    ...(error.cause !== undefined && depth < 2 ? { cause: describeError(error.cause, depth + 1) } : {}) };
}
