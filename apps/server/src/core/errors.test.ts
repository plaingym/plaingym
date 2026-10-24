// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { RevisionConflictError } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { createApp } from './app.js';
import { sourceUrl } from './source-link.js';
import { normalizeError } from './errors.js';
import { setLogSink } from './log.js';

it.each([
  [new AppError('unauthenticated', 'Sign in.'), 401, 'unauthenticated'],
  [new AppError('forbidden', 'Access denied.'), 403, 'forbidden'],
  [new AppError('not_found', 'Not found.'), 404, 'not_found'],
  [new AppError('rate_limited', 'Too many requests.'), 429, 'rate_limited'],
  [new RevisionConflictError(), 409, 'conflict'],
  [z.string().safeParse(42).error!, 400, 'invalid_request'],
  ...([400, 401, 403, 404, 409, 422, 429, 503] as const).map((status) => [new HTTPException(status, { message: 'private SQL and credentials' }), status === 422 ? 400 : status, undefined] as const),
  [new Error('select secret from private_table; password=hidden'), 500, 'internal'],
  [new HTTPException(500, { message: 'private SQL and credentials' }), 500, 'internal'],
] as const)('maps errors safely: %s', async (error, status, code) => {
  const app = createApp({ resolveGym: () => { throw error; }, session: async (_context, next) => { await next(); },
    authorize: () => async (_context, next) => { await next(); },
  });
  const response = await app.request('/api/fixture');
  expect(response.status).toBe(status);
  const body = await response.json();
  if (code) expect(body.error.code).toBe(code);
  expect(body.requestId).toBe(response.headers.get('x-request-id'));
  expect(JSON.stringify(body)).not.toMatch(/private SQL|credentials|private_table|password|stack/);
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
    // A query error carries the submitted values after its first line, as Drizzle's do.
    const failure = new Error('Failed query: insert into members (email) values ($1)\nparams: private@example.test',
      { cause: Object.assign(new Error('duplicate key value violates unique constraint "members_email_key"'),
        { code: '23505', table_name: 'members', constraint_name: 'members_email_key', detail: 'Key (email)=(private@example.test) already exists.' }) });
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
