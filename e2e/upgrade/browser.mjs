// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

export async function readPages({ loopback, port, ids, password, signatureHash, output, gate }) {
  const origin = `https://gym.localhost:${port}`;
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost ' + loopback, '--ignore-certificate-errors'] });
  const failedRequests = [];
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    const page = await context.newPage();
    const errors = [];
    const pending = new Set();
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) pending.add(request); });
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => {
      pending.delete(request);
      const url = new URL(request.url());
      const path = url.pathname + url.search;
      if (path.startsWith('/api/') || path === '/healthz' || request.isNavigationRequest()) failedRequests.push({ path, method: request.method(), error: request.failure()?.errorText });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      const path = url.pathname + url.search;
      if (path.startsWith('/api/') && response.status() >= 400) failedRequests.push({ path, status: response.status() });
      if (response.ok() && response.request().method() === 'GET') {
        for (const failure of failedRequests) {
          if (failure.path === path && failure.method === 'GET' && failure.error === 'net::ERR_NETWORK_CHANGED') failure.recovered = true;
        }
      }
    });
    const read = async path => {
      for (let attempt = 0; ; attempt++) {
        const firstFailure = failedRequests.length;
        try {
          return await page.evaluate(async path => {
            const response = await fetch(path, { signal: AbortSignal.timeout(15_000) });
            return { status: response.status, body: await response.json() };
          }, path);
        } catch (error) {
          // Docker bridge creation can invalidate Chromium's network generation. Retry only a GET that
          // explicitly failed for that reason; HTTP errors, timeouts, and all other transport errors still fail.
          const changed = failedRequests.slice(firstFailure).some(failure => failure.path === path && failure.error === 'net::ERR_NETWORK_CHANGED');
          if (!changed || attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    };
    // A static same-origin document cannot redirect while the login cookie is being established.
    // The login SPA may observe the new session and navigate, aborting a concurrent fixture read.
    await page.goto(origin + '/healthz');
    // Fetch in the browser so DNS, TLS, Origin, and secure session cookies all match the running install.
    const login = await page.evaluate(async ({ password }) => {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.test', password }) });
      await response.text();
      return response.status;
    }, { password });
    assert.equal(login, 200, 'historical owner can sign in');
    const response = await read('/healthz');
    assert.equal(response.status, 200); assert.equal(response.body.status, 'ok');
    for (const path of ['/api/dashboard', '/api/dashboard/billing', `/api/members/${ids.members}`, `/api/billing/invoices/${ids.invoices}`, '/api/health']) {
      console.log(`${gate}: read ${path}`);
      const result = await read(path);
      assert.equal(result.status, 200, `${gate}: ${path} reads historical data`);
      if (path === '/api/health') {
        assert.equal(result.body.data.tiles.length, 10);
        for (const tile of result.body.data.tiles) assert.notEqual(tile.status, 'error', `${gate}: ${tile.id} health`);
      }
    }
    const reads = [
      ['/admin', /Active members/],
      [`/admin/members/${ids.members}`, /Upgrade Member/],
      [`/admin/billing/invoices/${ids.invoices}`, /Historical membership/],
      ['/admin/health', /No failed background jobs/],
    ];
    const load = async (path, check) => {
      for (let attempt = 0; ; attempt++) {
        const firstFailure = failedRequests.length;
        try {
          await page.goto(origin + path);
          await check();
          await expect.poll(() => [...pending].map(request => new URL(request.url()).pathname), { timeout: 15_000 }).toEqual([]);
          assert.deepEqual(failedRequests.slice(firstFailure).filter(failure => !failure.recovered), [], 'page requests succeed');
          await expect(page.locator('main')).not.toContainText('Something went wrong');
          return;
        } catch (error) {
          // Reload only read-only pages affected by the same Docker network transition as fixture GETs.
          const failures = failedRequests.slice(firstFailure);
          if (attempt >= 2 || errors.length || !failures.length || !failures.every(failure => failure.method === 'GET' && failure.error === 'net::ERR_NETWORK_CHANGED')) throw error;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    };
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, text] of reads) {
        await load(path, () => expect(page.locator('main')).toContainText(text));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow, false, `${gate} ${path} horizontal overflow at ${width}px`);
        await page.screenshot({ path: `${output}/${gate}-${width}-${path.split('/').at(-1) || 'dashboard'}.png` });
      }
      await load(`/admin/members/${ids.members}`, async () => {
        await page.getByRole('tab', { name: 'Waivers and agreements', exact: true }).click();
        await expect(page.locator('main')).toContainText('Upgrade waiver');
        await expect(page.locator('main')).toContainText('Upgrade Member');
        await expect(page.locator('main')).toContainText(signatureHash);
      });
      await page.locator('li').filter({ hasText: signatureHash }).scrollIntoViewIfNeeded();
      await expect(page.getByText(signatureHash, { exact: true })).toBeVisible();
      await page.screenshot({ path: `${output}/${gate}-${width}-waiver.png` });
    }
    assert.deepEqual(errors, [], 'no browser exceptions on historical records');
    assert.deepEqual(failedRequests.filter(failure => !failure.recovered), [], 'every page API request succeeds');
    return { viewports: [360, 1280], pages: ['dashboard', 'member', 'invoice', 'waiver signature', 'health'], readiness: 'ok', networkRetries: failedRequests };
  } catch (error) {
    writeFileSync(`${output}/${gate}-http-errors.json`, JSON.stringify(failedRequests, null, 2) + '\n');
    throw error;
  } finally { await browser.close(); }
}
