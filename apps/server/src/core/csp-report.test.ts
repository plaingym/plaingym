// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import { createApp } from './app.js';
import { TestClock } from './clock.js';
import type { RequestEnvironment } from './context.js';
import { cspReportBytes } from './body-limit.js';
import { cspReportPath } from './csp.js';
import { reportedDirective, reportedDocumentPath, reportedResource } from './csp-report.js';
import { setLogSink } from './log.js';

const clock = new TestClock('2026-01-01T00:00:00Z');
const resolveGym: MiddlewareHandler<RequestEnvironment> = async (_context, next) => { await next(); };
const allow = () => async (_context: unknown, next: () => Promise<void>) => { await next(); };
const newApp = () => createApp({ clock, resolveGym, session: resolveGym, authorize: allow,
  // Tests choose the client address with a header.
  rateLimit: { peerAddress: (context) => context.req.header('x-peer') ?? '203.0.113.1' } });

let app = newApp(), lines: string[], previous: (line: string) => void;
beforeEach(() => { app = newApp(); lines = []; previous = setLogSink((line) => lines.push(line)); clock.set('2026-01-01T00:00:00Z'); });
afterEach(() => { setLogSink(previous); });
const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const post = (body: BodyInit | null, type = 'application/reports+json', headers: Record<string, string> = {}) =>
  app.request(cspReportPath, { method: 'POST', body, headers: { 'content-type': type, ...headers } });
const reportingBody = (body: Record<string, unknown>) => JSON.stringify([{ type: 'csp-violation', age: 3, url: 'https://gym.example.test/x', body }]);

const token = 'k3J9xQ2mZpL0vR8sT5uW7yB1cD4eF6gH-9aN_oIiM2q';
const secrets = [token, '0192f0c4-7d3e-7a10-8c55-2f1b6e0a9d11', 'jane@example.test', 'secret-sample', 'sid=abc123', 'Jane Doe', 'returned=1'];

describe('CSP violation reports', () => {
  it('logs a Reporting API report as directive, blocked origin and sanitized path, and answers 204', async () => {
    const response = await post(reportingBody({
      documentURL: `https://gym.example.test/l/${token}?returned=1&email=jane@example.test#frag`,
      blockedURL: 'https://cdn.example.test/path/to/script.js?sid=abc123', effectiveDirective: 'script-src-elem',
      violatedDirective: 'script-src', disposition: 'report', sample: 'secret-sample', referrer: 'https://gym.example.test/members/Jane%20Doe',
      sourceFile: 'https://gym.example.test/admin/members/0192f0c4-7d3e-7a10-8c55-2f1b6e0a9d11', lineNumber: 4,
    }), 'application/reports+json');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(events()).toEqual([{ time: expect.any(String), level: 'info', event: 'csp.violation', format: 'reports+json',
      directive: 'script-src-elem', blocked: 'https://cdn.example.test', path: '/l/:token' }]);
  });
  it('logs a legacy report-uri report', async () => {
    const response = await post(JSON.stringify({ 'csp-report': {
      'document-uri': 'https://gym.example.test/admin/members/0192f0c4-7d3e-7a10-8c55-2f1b6e0a9d11/billing?tab=x',
      'blocked-uri': 'https://img.example.test:8443/a.png?token=1', 'violated-directive': 'img-src', 'effective-directive': 'img-src',
      'script-sample': 'secret-sample', referrer: '', 'original-policy': "default-src 'self'", 'status-code': 200,
    } }), 'application/csp-report; charset=utf-8');
    expect(response.status).toBe(204);
    expect(events()).toMatchObject([{ event: 'csp.violation', format: 'csp-report', directive: 'img-src',
      blocked: 'https://img.example.test:8443', path: '/admin/members/:id/billing' }]);
  });
  it('falls back to the violated directive and reports keywords and schemes instead of paths', async () => {
    await post(JSON.stringify({ 'csp-report': { 'document-uri': 'https://gym.example.test/portal', 'blocked-uri': 'inline', 'violated-directive': 'style-src-attr \'self\'' } }), 'application/csp-report');
    await post(reportingBody({ documentURL: 'https://gym.example.test/', blockedURL: 'data', effectiveDirective: 'img-src' }));
    await post(reportingBody({ documentURL: 'https://gym.example.test/', blockedURL: 'data:image/png;base64,iVBOR', effectiveDirective: 'img-src' }));
    await post(reportingBody({ documentURL: 'https://gym.example.test/', blockedURL: 'eval', effectiveDirective: 'script-src' }));
    expect(events().map(({ directive, blocked, path }) => ({ directive, blocked, path }))).toEqual([
      { directive: 'style-src-attr', blocked: 'inline', path: '/portal' },
      { directive: 'img-src', blocked: 'data', path: '/' },
      { directive: 'img-src', blocked: 'data:', path: '/' },
      { directive: 'script-src', blocked: 'eval', path: '/' },
    ]);
  });
  it('logs each report of a batch, up to five, and skips other report types', async () => {
    const entry = (type: string) => ({ type, url: 'https://gym.example.test/', body: { documentURL: 'https://gym.example.test/admin', blockedURL: 'inline', effectiveDirective: 'script-src' } });
    const response = await post(JSON.stringify([entry('deprecation'), ...Array.from({ length: 14 }, () => entry('csp-violation'))]));
    expect(response.status).toBe(204);
    expect(events()).toHaveLength(5);
  });
  it('answers 204 and logs nothing for malformed, mistyped and unsupported bodies', async () => {
    for (const [body, type] of [['{"csp-report":', 'application/csp-report'], ['not json', 'application/reports+json'], ['', 'application/reports+json'],
      ['null', 'application/csp-report'], ['[1,"x",null,{"type":"csp-violation"}]', 'application/reports+json'],
      [JSON.stringify({ 'csp-report': 'x' }), 'application/csp-report'],
      [JSON.stringify({ 'csp-report': { 'blocked-uri': 'inline' } }), 'text/plain'],
      [JSON.stringify({ 'csp-report': { 'blocked-uri': 'inline' } }), 'application/json']] as const) {
      const response = await post(body, type);
      expect(response.status, `${type} ${body}`).toBe(204);
      expect(await response.text()).toBe('');
    }
    expect(lines).toEqual([]);
    // A header naming an inherited property is not a known format.
    for (const type of ['__proto__', 'constructor', 'toString']) expect((await post('{}', type)).status).toBe(204);
    expect(lines).toEqual([]);
  });
  it('refuses a body over 16 KiB, declared or chunked, without logging it', async () => {
    const big = reportingBody({ documentURL: 'https://gym.example.test/', blockedURL: 'inline', effectiveDirective: 'script-src', sample: 'x'.repeat(cspReportBytes) });
    expect((await post(big)).status).toBe(400);
    const chunks = [big.slice(0, 9000), big.slice(9000)];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
    const chunked = await app.request(cspReportPath, { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'application/reports+json' } } as RequestInit);
    expect(chunked.status).toBe(400);
    expect(lines).toEqual([]);
    const small = reportingBody({ documentURL: 'https://gym.example.test/', blockedURL: 'inline', effectiveDirective: 'script-src', sample: 'x'.repeat(8000) });
    expect(small.length).toBeLessThan(cspReportBytes);
    expect((await post(small)).status).toBe(204);
    expect(events()).toHaveLength(1);
  });
  it('needs no cookie, Origin or session, and ignores a forged one', async () => {
    const body = reportingBody({ documentURL: 'https://gym.example.test/admin', blockedURL: 'inline', effectiveDirective: 'script-src' });
    for (const headers of [{}, { cookie: 'session=secret' }, { cookie: 'session=secret', origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' }])
      expect((await post(body, 'application/reports+json', headers)).status).toBe(204);
    expect(events()).toHaveLength(3);
  });
  it('limits each client to 30 requests a minute and the install to 300, dropping the rest silently', async () => {
    const body = reportingBody({ documentURL: 'https://gym.example.test/admin', blockedURL: 'inline', effectiveDirective: 'script-src' });
    for (let i = 0; i < 30; i++) expect((await post(body)).status).toBe(204);
    expect(events()).toHaveLength(30);
    const over = await post(body);
    expect(over.status).toBe(204);
    expect(over.headers.has('retry-after')).toBe(false);
    expect(events()).toHaveLength(30);
    // Another client still gets through, until the install's own budget is spent.
    expect((await post(body, 'application/reports+json', { 'x-peer': '203.0.113.2' })).status).toBe(204);
    expect(events()).toHaveLength(31);
    for (let peer = 3; peer < 3 + 9; peer++) for (let i = 0; i < 30; i++) await post(body, 'application/reports+json', { 'x-peer': `203.0.113.${peer}` });
    // 31 requests passed their client budgets, then 270 more: the 300th is the last the install admits.
    expect(events()).toHaveLength(300);
    clock.set('2026-01-01T00:01:01Z');
    await post(body);
    expect(events()).toHaveLength(301);
  });
  it('answers other methods without a report', async () => {
    expect((await app.request(cspReportPath)).status).not.toBe(204);
    expect(lines).toEqual([]);
  });
  it('shows up in the OpenAPI document as a public operation', () => {
    const route = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } }).paths?.[cspReportPath]?.post as { permission?: unknown } | undefined;
    expect(route).toBeDefined();
  });
});

describe('no token or visitor data reaches the log', () => {
  it('logs only the sanitized fields, whatever the report holds', async () => {
    const hostile = {
      documentURL: `https://gym.example.test/l/${token}/extra?email=jane@example.test&returned=1#Jane Doe`,
      blockedURL: `https://user:pass@cdn.example.test/${token}?sid=abc123#Jane%20Doe`, effectiveDirective: 'script-src', sample: 'secret-sample',
      referrer: 'https://gym.example.test/members/Jane Doe', sourceFile: `https://gym.example.test/${token}`, originalPolicy: 'sid=abc123',
    };
    await post(reportingBody(hostile));
    await post(JSON.stringify({ 'csp-report': { 'document-uri': `https://gym.example.test/portal/invoices/0192f0c4-7d3e-7a10-8c55-2f1b6e0a9d11?email=jane@example.test`,
      'blocked-uri': `https://cdn.example.test/${token}`, 'violated-directive': 'Jane Doe', 'script-sample': 'secret-sample' } }), 'application/csp-report');
    await post(reportingBody({ documentURL: `https://gym.example.test/members/Jane%20Doe/${token}`, blockedURL: 'sid=abc123',
      effectiveDirective: `script-src ${token}` }));
    expect(lines).toHaveLength(3);
    for (const secret of secrets) for (const line of lines) expect(line, secret).not.toContain(secret);
    expect(events().map(({ directive, blocked, path }) => ({ directive, blocked, path }))).toEqual([
      { directive: 'script-src', blocked: 'https://cdn.example.test', path: '/l/:token' },
      { directive: 'other', blocked: 'https://cdn.example.test', path: '/portal/invoices/:id' },
      { directive: 'script-src', blocked: 'other', path: '/members/:id/:id' },
    ]);
  });
});

describe('sanitizers', () => {
  it('replaces tokens, IDs and names in a document path', () => {
    expect(reportedDocumentPath('https://gym.example.test/')).toBe('/');
    expect(reportedDocumentPath('https://gym.example.test/admin/members/0192F0C4-7D3E-7A10-8C55-2F1B6E0A9D11')).toBe('/admin/members/:id');
    expect(reportedDocumentPath('https://gym.example.test/admin/classes/42/roster')).toBe('/admin/:id/:id/:id');
    // A lowercase name or slug is as identifying as a token; only the app's own route words stay.
    expect(reportedDocumentPath('https://gym.example.test/members/jane')).toBe('/members/:id');
    expect(reportedDocumentPath('https://gym.example.test/gyms/acme-martial-arts/schedule')).toBe('/:id/:id/schedule');
    expect(reportedDocumentPath('https://gym.example.test/l')).toBe('/l');
    expect(reportedDocumentPath('https://gym.example.test/l/')).toBe('/l');
    expect(reportedDocumentPath('https://gym.example.test/l/return')).toBe('/l/:token');
    expect(reportedDocumentPath('https://gym.example.test/drop-in/received')).toBe('/drop-in/received');
    expect(reportedDocumentPath('https://gym.example.test/a/b/c/d/e/f/g/h/i/j')).toBe('/:id/:id/:id/:id/:id/:id/:id/:id/*');
    expect(reportedDocumentPath('https://gym.example.test/%E2%9C%93/caf%C3%A9')).toBe('/:id/:id');
    for (const value of [undefined, 42, '', 'about:blank', 'javascript:alert(1)', '/relative/path', {}]) expect(reportedDocumentPath(value)).toBe('unknown');
  });
  it('keeps the origin or keyword of a blocked resource, never more', () => {
    expect(reportedResource('https://cdn.example.test/a/b.js?x=1#y')).toBe('https://cdn.example.test');
    expect(reportedResource('wss://live.example.test:9000/socket')).toBe('wss://live.example.test:9000');
    expect(reportedResource('blob:https://gym.example.test/0192f0c4-7d3e-7a10-8c55-2f1b6e0a9d11')).toBe('blob:');
    expect(reportedResource('chrome-extension://abcdefgh/script.js')).toBe('chrome-extension:');
    expect(reportedResource('inline')).toBe('inline');
    expect(reportedResource('some free text')).toBe('other');
    expect(reportedResource(`https://${'a'.repeat(300)}.test/`)).toBe('other');
    for (const value of [undefined, null, 5, '', '  ']) expect(reportedResource(value)).toBe('unknown');
  });
  it('names only known directives', () => {
    expect(reportedDirective('Script-Src-Elem \'self\'')).toBe('script-src-elem');
    expect(reportedDirective(undefined, 'img-src https:')).toBe('img-src');
    expect(reportedDirective('made-up-src')).toBe('other');
    expect(reportedDirective(undefined, 7, '')).toBe('unknown');
  });
});
