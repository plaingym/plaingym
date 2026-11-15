// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { retryableRequest, retryNetworkChange } from './retry.mjs';

const pageExpect = expect.configure({ timeout: 15_000 });

export async function readPages({ loopback, port, ids, password, signatureHash, output, gate }) {
  const origin = `https://gym.localhost:${port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost ' + loopback, '--ignore-certificate-errors'] });
  const failedRequests = [];
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    page = await context.newPage();
    const pending = new Set();
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) pending.add(request); });
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => {
      pending.delete(request);
      const url = new URL(request.url());
      const path = url.pathname + url.search;
      // Asset GETs can fail during the same network transition and prevent the SPA from mounting.
      failedRequests.push({ path, method: request.method(), error: request.failure()?.errorText });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      const path = url.pathname + url.search;
      if (response.status() >= 400) failedRequests.push({ path, status: response.status() });
      if (response.ok()) {
        for (const failure of failedRequests) {
          if (failure.path === path && failure.method === response.request().method() && retryableRequest(failure)) failure.recovered = true;
        }
      }
    });
    const retry = (method, path, operation) => retryNetworkChange(operation, { method, path, failedRequests, errors });
    const read = path => retry('GET', path, () => page.evaluate(async path => {
      const response = await fetch(path, { signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: await response.json() };
    }, path));
    // A static same-origin document cannot redirect while the login cookie is being established.
    // The login SPA may observe the new session and navigate, aborting a concurrent fixture read.
    await retry('GET', '/healthz', async () => {
      const response = await page.goto(origin + '/healthz');
      assert.equal(response.status(), 200, 'initial health navigation succeeds');
    });
    // Fetch in the browser so DNS, TLS, Origin, and secure session cookies all match the running install.
    const login = await retry('POST', '/api/auth/sign-in/email', () => page.evaluate(async ({ password }) => {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.test', password }) });
      await response.text();
      return response.status;
    }, { password }));
    assert.equal(login, 200, 'historical owner can sign in');
    const response = await read('/healthz');
    assert.equal(response.status, 200); assert.equal(response.body.status, 'ok');
    for (const path of ['/api/dashboard', '/api/dashboard/billing', `/api/members/${ids.members}`, `/api/billing/invoices/${ids.invoices}`, '/api/health']) {
      console.log(`${gate}: read ${path}`);
      const result = await read(path);
      assert.equal(result.status, 200, `${gate}: ${path} reads historical data`);
      if (path === '/api/health') {
        assert.ok(result.body.data.tiles.length > 0, `${gate}: health tiles are present`);
        for (const tile of result.body.data.tiles) assert.notEqual(tile.status, 'error', `${gate}: ${tile.id} health`);
        assert.equal(result.body.data.tiles.find(tile => tile.id === 'smtp')?.status, 'healthy', `${gate}: historical SMTP config is readable`);
      }
    }
    const reads = [
      ['/admin', /Active members/],
      [`/admin/members/${ids.members}`, /Upgrade Member/],
      [`/admin/billing/invoices/${ids.invoices}`, /Historical membership/],
      ['/admin/health', /No failed background jobs/],
    ];
    const load = (path, check) => retry('GET', path, async firstFailure => {
      const response = await page.goto(origin + path);
      assert.equal(response.status(), 200, `${path}: page navigation succeeds`);
      await check();
      await pageExpect.poll(() => [...pending].map(request => new URL(request.url()).pathname)).toEqual([]);
      assert.deepEqual(failedRequests.slice(firstFailure).filter(failure => !failure.recovered), [], 'page requests succeed');
      await pageExpect(page.locator('main')).not.toContainText('Something went wrong');
    });
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, text] of reads) {
        await load(path, () => pageExpect(page.locator('main')).toContainText(text));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow, false, `${gate} ${path} horizontal overflow at ${width}px`);
        await page.screenshot({ path: `${output}/${gate}-${width}-${path.split('/').at(-1) || 'dashboard'}.png` });
      }
      await load(`/admin/members/${ids.members}`, async () => {
        await page.getByRole('tab', { name: 'Waivers and agreements', exact: true }).click();
        await pageExpect(page.locator('main')).toContainText('Upgrade waiver');
        await pageExpect(page.locator('main')).toContainText('Upgrade Member');
        await pageExpect(page.locator('main')).toContainText(signatureHash);
      });
      await page.locator('li').filter({ hasText: signatureHash }).scrollIntoViewIfNeeded();
      await pageExpect(page.getByText(signatureHash, { exact: true })).toBeVisible();
      await page.screenshot({ path: `${output}/${gate}-${width}-waiver.png` });
    }
    assert.deepEqual(errors, [], 'no browser exceptions on historical records');
    assert.deepEqual(failedRequests.filter(failure => !failure.recovered), [], 'every page API request succeeds');
    return { viewports: [360, 1280], pages: ['dashboard', 'member', 'invoice', 'waiver signature', 'health'], readiness: 'ok', networkRetries: failedRequests };
  } catch (error) {
    writeFileSync(`${output}/${gate}-http-errors.json`, JSON.stringify(failedRequests, null, 2) + '\n');
    writeFileSync(`${output}/${gate}-browser-errors.json`, JSON.stringify({ url: page?.url(), errors }, null, 2) + '\n');
    try { await page?.screenshot({ path: `${output}/${gate}-failure.png` }); } catch { /* Keep the original failure. */ }
    throw error;
  } finally { await browser.close(); }
}
