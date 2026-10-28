// SPDX-License-Identifier: AGPL-3.0-only
import { createServer as httpServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'vite';
import { developmentProxy } from '../../dev-proxy.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return String((server.address() as AddressInfo).port);
}
it('proxies signed pages, assets, returns and POSTs with sandbox authority, cookies and query intact', async () => {
  const seen: { url: string | undefined; host: string | undefined; cookie: string | undefined; method: string | undefined }[] = [];
  const backend = httpServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie, method: req.method });
    if (req.url === '/l/return?returned=1') { res.writeHead(302, { location: '/l/example?returned=1', 'set-cookie': 'return=cleared; Path=/l; HttpOnly' }); res.end(); }
    else { res.writeHead(req.url === '/l/invalid' ? 404 : 200, { 'content-type': req.url?.endsWith('.css') ? 'text/css' : 'text/html' }); res.end('server-rendered'); }
  });
  const backendPort = await listen(backend);
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, proxy: developmentProxy(backendPort) } });
  cleanups.push(() => vite.close());
  const frontend = httpServer((req, res) => vite.middlewares(req, res, () => { res.statusCode = 418; res.end('SPA'); }));
  const port = await listen(frontend);
  const headers = { host: 'sample.demo.localhost', cookie: 'scope=local', origin: 'https://sample.demo.localhost' };
  async function get(path: string, method = 'GET') {
    return new Promise<{ status: number; text: string; location?: string; cookie?: string[] }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, text, ...(res.headers.location ? { location: res.headers.location } : {}), ...(res.headers['set-cookie'] ? { cookie: res.headers['set-cookie'] } : {}) }));
      }); req.on('error', reject); req.end();
    });
  }
  for (const path of ['/l/example?tablet=1', '/l/styles.css', '/l/client.js', '/l/invalid', '/l/return?returned=1']) {
    const response = await get(path);
    expect(response.status).toBe(path === '/l/invalid' ? 404 : path.startsWith('/l/return') ? 302 : 200);
    if (response.status === 302) { expect(response.location).toBe('/l/example?returned=1'); expect(response.cookie?.[0]).toContain('HttpOnly'); }
    else expect(response.text).toBe('server-rendered');
  }
  await get('/api/links/example/complete', 'POST');
  expect(seen).toHaveLength(6);
  expect(seen.map(request => ({ host: request.host, cookie: request.cookie }))).toEqual(Array.from({ length: 6 }, () => ({ host: headers.host, cookie: headers.cookie })));
  expect(seen[0]?.url).toBe('/l/example?tablet=1'); expect(seen[5]?.method).toBe('POST');
  expect((await fetch(`http://127.0.0.1:${port}/login`)).status).toBe(418);
});
