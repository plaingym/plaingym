// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
// eslint-disable-next-line database/system-tables -- Only constructs a query error as Drizzle raises it; it builds no SQL and names no table.
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { RevisionConflictError } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { createApp } from './app.js';
import { sourceUrl } from './source-link.js';
import { busyReason, isBusy, normalizeError, readJsonBody } from './errors.js';
import { logError, setLogSink } from './log.js';

/** Logs `error` through the shared logger and returns the one line it wrote and its parsed `error` field. */
function logged(error: unknown): { line: string; error: Record<string, unknown> } {
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  try { logError('fixture.failed', { gymId: 'gym-1' }, error); } finally { setLogSink(previous); }
  expect(lines).toHaveLength(1);
  return { line: lines[0]!, error: JSON.parse(lines[0]!).error };
}

it('maps only body JSON syntax errors to invalid_request', async () => {
  expect(await readJsonBody(new Request('https://gym.invalid', { method: 'POST', body: '{"revision":1}' }))).toEqual({ revision: 1 });
  await expect(readJsonBody(new Request('https://gym.invalid', { method: 'POST', body: 'not JSON' })))
    .rejects.toMatchObject({ code: 'invalid_request', status: 400, message: 'Request body must be JSON' });
  const failure = new Error('stream failed');
  await expect(readJsonBody({ json: async () => { throw failure; } })).rejects.toBe(failure);
  // A programming SyntaxError outside the body reader remains a server error.
  expect(normalizeError(new SyntaxError('broken code')).code).toBe('internal');
});

it.each([
  [new AppError('unauthenticated', 'Sign in.'), 401, 'unauthenticated'],
  [new AppError('forbidden', 'Access denied.'), 403, 'forbidden'],
  [new AppError('not_found', 'Not found.'), 404, 'not_found'],
  [new AppError('rate_limited', 'Too many requests.'), 429, 'rate_limited'],
  [new RevisionConflictError(), 409, 'conflict'],
  [z.string().safeParse(42).error!, 400, 'invalid_request'],
  ...([400, 401, 403, 404, 409, 422, 429, 503] as const).map((status) => [new HTTPException(status, { message: 'private SQL and credentials' }), status === 422 ? 400 : status, undefined] as const),
  // A body too large, or of a type the route doesn't take, is the caller's mistake: an invalid request, not a server error.
  ...([413, 415] as const).map((status) => [new HTTPException(status, { message: 'private SQL and credentials' }), 400, 'invalid_request'] as const),
  [new Error('select secret from private_table; password=hidden'), 500, 'internal'],
  [new HTTPException(500, { message: 'private SQL and credentials' }), 500, 'internal'],
] as const)('maps errors safely: %s', async (error, status, code) => {
  const app = createApp({ resolveGym: () => { throw error; }, session: async (_context, next) => { await next(); },
    authorize: () => async (_context, next) => { await next(); },
  });
  const response = await app.request('/api/fixture');
  expect(response.status).toBe(status);
  // Only a momentarily full queue (the busy reason) says to ask again in a second.
  if (status === 429) expect(response.headers.get('Retry-After')).toBeNull();
  const body = await response.json();
  if (code) expect(body.error.code).toBe(code);
  if (error instanceof RevisionConflictError) expect(body.error.details).toEqual({ reason: ['revision_conflict'] });
  expect(body.requestId).toBe(response.headers.get('x-request-id'));
  expect(JSON.stringify(body)).not.toMatch(/private SQL|credentials|private_table|password|stack/);
});

it('adds a one-second Retry-After only to a busy refusal, and keeps a limiter\'s own', async () => {
  const respond = (error: AppError, header?: string) => createApp({ resolveGym: (context) => { if (header) context.header('Retry-After', header); throw error; },
    session: async (_context, next) => { await next(); }, authorize: () => async (_context, next) => { await next(); } }).request('/api/fixture');
  const busy = await respond(new AppError('rate_limited', 'PDF processing is busy; please retry shortly', { reason: [busyReason] }));
  expect(busy.status).toBe(429); expect(busy.headers.get('Retry-After')).toBe('1');
  expect((await busy.json()).error.details).toEqual({ reason: ['busy'] });
  const quota = await respond(new AppError('rate_limited', 'The demo signature upload limit has been reached'));
  expect(quota.status).toBe(429); expect(quota.headers.get('Retry-After')).toBeNull();
  expect((await respond(new AppError('rate_limited', 'Too many requests.'), '60')).headers.get('Retry-After')).toBe('60');
  expect(isBusy(new AppError('rate_limited', 'x', { reason: ['other'] }))).toBe(false);
  expect(isBusy(new AppError('conflict', 'x', { reason: [busyReason] }))).toBe(false);
});

it('preserves explicitly public error details', () => {
  const error = new AppError('invalid_request', 'Check the form.', { name: ['Required.'] });
  expect(normalizeError(error)).toBe(error);
});

it.each(['javascript:alert(1)', 'file:///private/key', 'https://user:password@example.org', 'invalid'])('rejects unsafe source links: %s', (value) => {
  expect(() => sourceUrl(value)).toThrow();
});

it('reads the source override at factory creation', () => {
  const previous = process.env.SOURCE_URL;
  try {
    process.env.SOURCE_URL = 'https://example.org/modified/tag';
    expect(sourceUrl()).toBe('https://example.org/modified/tag');
    delete process.env.SOURCE_URL;
    expect(sourceUrl()).toBe('https://github.com/plaingym/plaingym');
  } finally {
    if (previous === undefined) delete process.env.SOURCE_URL;
    else process.env.SOURCE_URL = previous;
  }
});

it('logs an unexpected error by request ID and route, without bound parameters or the request path', async () => {
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  try {
    // A query error Drizzle raises carries the submitted values after its first line.
    const failure = new DrizzleQueryError('insert into members (email) values ($1)', ['private@example.test'],
      Object.assign(new Error('duplicate key value violates unique constraint "members_email_key"'),
        { code: '23505', table_name: 'members', constraint_name: 'members_email_key', detail: 'Key (email)=(private@example.test) already exists.' }));
    const app = createApp({ resolveGym: async (_context, next) => { await next(); }, session: async (_context, next) => { await next(); },
      authorize: () => async (_context, next) => { await next(); } });
    app.get('/l/:token', () => { throw failure; });
    app.get('/api/known', () => { throw new AppError('not_found', 'Not found.'); });
    const response = await app.request('/l/secret-link-token?signature=secret');
    expect(response.status).toBe(500);
    expect((await app.request('/api/known')).status).toBe(404);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'error', event: 'http.unhandled', requestId: response.headers.get('x-request-id'), method: 'GET', route: '/l/:token',
      error: { name: 'Error', query: 'insert into members (email) values ($1)',
        cause: { code: '23505', table_name: 'members', constraint_name: 'members_email_key' } } });
    expect(entry.error.message).toBeUndefined(); expect(entry.error.cause.message).toBeUndefined();
    expect(entry.error.frames.length).toBeGreaterThan(0);
    for (const secret of ['private@example.test', 'secret-link-token', 'signature']) expect(lines[0]).not.toContain(secret);
  } finally { setLogSink(previous); }
});

it('never logs what an error message or its cause says, even on the first line', async () => {
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  try {
    const failure = new Error('select secret from private_table; password=hidden',
      { cause: Object.assign(new Error('invalid input syntax for type uuid: "private@example.test"'), { code: '22P02', routine: 'string_to_uuid' }) });
    const app = createApp({ resolveGym: async (_context, next) => { await next(); }, session: async (_context, next) => { await next(); },
      authorize: () => async (_context, next) => { await next(); } });
    app.get('/api/fail', () => { throw failure; });
    expect((await app.request('/api/fail')).status).toBe(500);
    expect(JSON.parse(lines[0]!).error).toMatchObject({ name: 'Error', cause: { code: '22P02', routine: 'string_to_uuid' } });
    for (const secret of ['password', 'hidden', 'private_table', 'private@example.test']) expect(lines.join(' ')).not.toContain(secret);
  } finally { setLogSink(previous); }
});

it('logs a query only from a query error Drizzle raised, never from a message that starts the same way', () => {
  const lookalike = () => new Error('Failed query: select secret_column from private_table\nparams: private@example.test');
  // The lookalike as the root error, its cause, and its cause's cause: every serialized depth.
  const { line, error } = logged(Object.assign(lookalike(), { cause: Object.assign(lookalike(), { cause: lookalike() }) }));
  expect(error).toMatchObject({ name: 'Error', cause: { name: 'Error', cause: { name: 'Error' } } });
  expect(line).not.toContain('"query"');
  for (const secret of ['Failed query', 'secret_column', 'private_table', 'private@example.test']) expect(line).not.toContain(secret);
  // A real one keeps its SQL diagnostic at a nested depth too, still without its bound parameters.
  const nested = logged(new Error('request failed', { cause: new DrizzleQueryError('select id from members where email = $1', ['private@example.test']) }));
  expect(nested.error).toMatchObject({ cause: { name: 'Error', query: 'select id from members where email = $1' } });
  expect(nested.line).not.toContain('private@example.test');
});

it('logs no line of a multiline message as a stack frame, at any depth', () => {
  const quoting = () => new Error('lookup failed\n    at privateFrame (private@example.test)\n    at hidden-value');
  const { line, error } = logged(Object.assign(quoting(), { cause: Object.assign(quoting(), { cause: quoting() }) }));
  const levels = [error, error.cause, (error.cause as Record<string, unknown>).cause] as Array<Record<string, unknown>>;
  for (const level of levels) {
    expect((level.frames as string[]).length).toBeGreaterThan(0);
    for (const frame of level.frames as string[]) expect(frame).toMatch(/^at /);
  }
  for (const secret of ['lookup failed', 'privateFrame', 'private@example.test', 'hidden-value']) expect(line).not.toContain(secret);
});

it('keeps a conventional stack\'s frames and logs none from a stack whose header is not the error\'s own', () => {
  for (const error of [new Error('boom'), new TypeError('bad value')]) {
    const frames = logged(error).error.frames as string[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(15);
    expect(frames.every((frame) => frame.startsWith('at '))).toBe(true);
  }
  // Node heads an empty message's stack with the name alone. The test runner's source-map formatter writes
  // `Error: ` instead, so this stack is the one Node writes, set by hand.
  const empty = Object.assign(new Error(''), { stack: 'Error\n    at run (/app/server.js:1:1)\n    at main (/app/server.js:2:1)' });
  expect(logged(empty).error.frames).toEqual(['at run (/app/server.js:1:1)', 'at main (/app/server.js:2:1)']);
  const rewritten = () => Object.assign(new Error('boom'), { stack: 'Error: private@example.test\n    at privateFrame (private.ts:1:1)' });
  const { line, error } = logged(Object.assign(rewritten(), { cause: Object.assign(rewritten(), { cause: rewritten() }) }));
  expect(error).toMatchObject({ frames: [], cause: { frames: [], cause: { frames: [] } } });
  for (const secret of ['private@example.test', 'privateFrame']) expect(line).not.toContain(secret);
  expect(logged(Object.assign(new Error('boom'), { stack: undefined })).error.frames).toEqual([]);
});

it('logs the frames after a literal Node stack header, at most 15 and trimmed', () => {
  // Literal stacks, so the test runner's stack formatter cannot change what the parser reads.
  const multiline = Object.assign(new Error('lookup failed\n    at privateFrame (private.ts:9:9)'),
    { stack: 'Error: lookup failed\n    at privateFrame (private.ts:9:9)\n    at run (/app/server.js:1:1)' });
  const { line, error } = logged(multiline);
  expect(error.frames).toEqual(['at run (/app/server.js:1:1)']);
  expect(line).not.toContain('privateFrame');
  const mismatched = Object.assign(new TypeError('boom'), { stack: 'Error: boom\n    at run (/app/server.js:1:1)' });
  expect(logged(mismatched).error.frames).toEqual([]);
  const lines = Array.from({ length: 16 }, (_, index) => `    at step${index} (/app/server.js:${index + 1}:1) `);
  const empty = Object.assign(new Error(''), { stack: `Error\n${lines.join('\n')}` });
  expect(logged(empty).error.frames).toEqual(lines.slice(0, 15).map((frame) => frame.trim()));
});
