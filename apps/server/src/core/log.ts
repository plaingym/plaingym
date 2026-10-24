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
/**
 * An error's name, code, first message line, and stack frames, plus its cause. Query errors put their bound
 * parameters (submitted values) after the first line, and attached details stay out entirely.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = (error as { code?: unknown }).code;
  const frames = (error.stack ?? '').split('\n').filter((line) => line.trim().startsWith('at ')).slice(0, 15).map((line) => line.trim());
  return { name: error.name, ...(typeof code === 'string' ? { code } : {}), message: (error.message.split('\n')[0] ?? '').slice(0, 300),
    frames, ...(error.cause !== undefined && depth < 2 ? { cause: describeError(error.cause, depth + 1) } : {}) };
}
