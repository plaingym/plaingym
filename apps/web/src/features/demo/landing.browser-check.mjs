// SPDX-License-Identifier: AGPL-3.0-only
// Optional layout check of a sandbox's start page and demo controls: install the pinned e2e tooling first
// (`pnpm --dir e2e install --frozen-lockfile`). No production services are started; discovery is a fixture.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const e2e = path => new URL('e2e/node_modules/' + path, 'file:///' + root.replaceAll('\\', '/')).href;
const { chromium, expect } = await import(e2e('@playwright/test/index.mjs'));
const { default: AxeBuilder } = await import(e2e('@axe-core/playwright/dist/index.mjs'));
const output = resolve(root, 'coverage/demo/browser'), work = resolve(root, 'apps/web/coverage/demo');
await mkdir(output, { recursive: true }); await mkdir(work, { recursive: true });
const modulePath = path => '/@fs/' + resolve(root, path).replaceAll('\\', '/');
await writeFile(resolve(work, 'fixture.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DemoShell } from '${modulePath('apps/web/src/features/demo/notice.tsx')}';
import { DemoPage } from '${modulePath('apps/web/src/features/demo/landing.tsx')}';
import '${modulePath('apps/web/src/app/styles.css')}';
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}>
  <DemoShell><DemoPage /></DemoShell></QueryClientProvider>);
`);
// The banner reads only the current path from the router.
const router = { name: 'demo-router-fixture', enforce: 'pre', resolveId: id => id === '@tanstack/react-router' ? '\0demo-router' : undefined,
  load: id => id === '\0demo-router' ? 'export const useRouterState = ({ select }) => select({ location: { pathname: location.pathname.replace(/^\\/fixture/, "") || "/" } });' : undefined };
const server = await createServer({ configFile: false, appType: 'custom', root: resolve(root, 'apps/web'), plugins: [router, react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] } });
// Installed before the modules load, since the app's JSON transport binds fetch at import.
const discovery = "const expiresAt = new Date(Date.now() + 86400000).toISOString(); window.fetch = async (input) => new URL(input instanceof Request ? input.url : String(input), location.href).pathname === '/api/demo' ? Response.json({ data: { mode: 'sandbox', expiresAt } }) : Response.json({}, { status: 404 });";
server.middlewares.use('/fixture', async (req, res) => {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo start page</title><script>' + discovery + '</script></head><body><div id="root"></div><script type="module" src="' + modulePath('apps/web/coverage/demo/fixture.tsx') + '"></script></body></html>';
  res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url ?? '/', html));
});
let browser;
const timer = setTimeout(() => { console.error('Demo browser check timed out'); process.exit(1); }, 120_000);
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const errors = [], results = [];
  for (const width of [360, 1280]) for (const path of ['/demo', '/admin']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (process.env.DEBUG_CHECK) console.log('console:', message.text()); });
    await page.goto('http://127.0.0.1:' + address.port + '/fixture' + path);
    await expect(page.getByRole('heading', { level: 1, name: 'Your demo gym' })).toBeVisible();
    await expect(page.getByText('4242 4242 4242 4242')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Demo start page' })).toHaveCount(path === '/demo' ? 0 : 1);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    const small = await page.locator('a, button').evaluateAll(elements => elements.filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width > 0 && (bounds.height < 44 || bounds.width < 44);
    }).map(element => element.outerHTML));
    expect(small).toEqual([]);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: resolve(output, 'start' + path.replace('/', '-') + '-' + width + '.png'), fullPage: true });
    results.push({ width, path, overflow: false, minimumTarget: 44, axeViolations: 0 });
    await context.close();
  }
  expect(errors).toEqual([]); await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { clearTimeout(timer); await browser?.close(); await server.close(); }
