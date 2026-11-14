// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BrowserContext, Locator, Page, Request } from '@playwright/test';
import { test, expect, gymOrigin, demoClient } from '../support.js';
import { stripeOrigin } from '../portal.js';
import { outputRoot, uxPass } from './capture.js';
import { startProxy } from './proxy.js';

// Firefox and WebKit submit the join form (with its signatures) and a CSV upload through the stack's HTTPS proxy, Caddy. These
// routes require Content-Length, which until now only Chromium had been seen to send. Playwright's WebKit is not Safari.
test.skip(!uxPass, 'The UX pass runs only with UX_PASS=1');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

/** The routes that refuse a body without Content-Length, and what each request of theirs carried and got back. */
// With scripts the join form sends `/join/signatures` then `/api/public/join`; without them the browser posts the form to `/join`.
const bounded = (url: URL) => ['/join', '/join/signatures', '/api/public/join', '/api/imports/uploads'].includes(url.pathname);
interface Evidence { method: string; path: string; contentLength: string | null; transferEncoding: string | null; status: number | null }
function watch(context: BrowserContext) {
  const seen: Evidence[] = [];
  const record = async (request: Request) => {
    const url = new URL(request.url());
    if (request.method() !== 'POST' || !bounded(url)) return;
    const response = await request.response().catch(() => null);
    seen.push({ method: request.method(), path: url.pathname, contentLength: await request.headerValue('content-length'),
      transferEncoding: await request.headerValue('transfer-encoding'), status: response?.status() ?? null });
  };
  // A response, not requestfinished: WebKit doesn't finish a form POST whose answer navigates the page away.
  context.on('response', (response) => void record(response.request()));
  context.on('requestfailed', (request) => void record(request));
  return seen;
}
/** The evidence, a screenshot, and any CSP console lines (kept for review: Playwright's WebKit reports some for its own work). */
async function report(browserName: string, name: string, page: Page, seen: Evidence[], csp: string[]) {
  const directory = new URL(`browsers/${browserName}/`, outputRoot);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(name + '.png', directory), await page.screenshot({ fullPage: true }));
  await writeFile(new URL(name + '.json', directory), JSON.stringify({ requests: seen, csp: csp.splice(0) }, null, 2));
}
/** Draws one stroke on a signature canvas. */
async function sign(canvas: Locator, page: Page) {
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.7);
  await page.mouse.down();
  for (const step of [0.3, 0.45, 0.6, 0.75, 0.85]) await page.mouse.move(box.x + box.width * step, box.y + box.height * (step % 0.3 + 0.3), { steps: 4 });
  await page.mouse.up();
}

let proxy: Awaited<ReturnType<typeof startProxy>>;
test.beforeAll(async () => { proxy = await startProxy(); });
test.afterAll(async () => { await proxy?.close(); });

for (const [name, viewport] of [['phone', { width: 360, height: 740 }], ['desktop', { width: 1280, height: 800 }]] as const) {
  test(`progress bars at ${name} size`, async ({ browser, browserName, sandboxes, cspViolations }) => {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    try {
      await (await demoClient(sandboxes[1]!, 'student')).browser(context);
      const page = await context.newPage();
      await page.goto(sandboxes[1]!.origin + '/portal/progress');
      await expect(page.locator('progress').first()).toBeVisible();
      await report(browserName, `progress-${name}`, page, [], cspViolations);
    } finally { await context.close(); }
  });
  test(`join with a signed waiver at ${name} size`, async ({ browser, browserName, sandboxes, cspViolations }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    const seen = watch(context), page = await context.newPage();
    try {
      const origin = sandboxes[1]!.origin, lastName = 'Browser' + randomBytes(3).toString('hex');
      await page.goto(origin + '/join');
      await expect(page.getByRole('heading', { name: 'Join', exact: true })).toBeVisible();
      await page.getByRole('link', { name: /^Choose / }).first().click();
      await expect(page.getByRole('heading', { name: /^Join: / })).toBeVisible();
      await page.getByLabel('Contact or parent/guardian name', { exact: true }).fill('Riley ' + lastName);
      await page.getByLabel('Email', { exact: true }).fill(`browser-${randomBytes(6).toString('hex')}@example.invalid`);
      await page.getByLabel('First name', { exact: true }).fill('Riley');
      await page.getByLabel('Last name', { exact: true }).fill(lastName);
      await page.getByLabel('Date of birth', { exact: true }).fill('1994-05-06');
      const waivers = page.locator('fieldset[data-waiver]:visible');
      expect(await waivers.count()).toBeGreaterThan(0);
      for (const waiver of await waivers.all()) {
        await waiver.getByRole('combobox', { name: 'Who is signing?', exact: true }).selectOption({ label: 'I am this adult participant' });
        await waiver.getByLabel('Signer full name', { exact: true }).fill('Riley ' + lastName);
        await sign(waiver.locator('canvas'), page);
        await waiver.getByLabel('I have read and agree to this document.', { exact: true }).check();
      }
      await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/join/checkout' || url.origin === stripeOrigin);
      await expect.poll(() => seen.filter((entry) => entry.path === '/api/public/join').length).toBeGreaterThan(0);
      await report(browserName, `join-${name}`, page, seen, cspViolations);
      expect(seen.filter((entry) => entry.status === null || entry.status >= 400), 'every bounded request was accepted').toEqual([]);
      expect(seen.map((entry) => entry.path)).toContain('/join/signatures');
    } finally { await context.close(); }
  });

  test(`join form posted without scripts at ${name} size`, async ({ browser, browserName, sandboxes, cspViolations }) => {
    // No signature can be drawn without scripts, so the join itself is refused; what matters is that the body was read:
    // the answer is the form again with its own message, never a refusal for a missing Content-Length.
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, javaScriptEnabled: false });
    const seen = watch(context), page = await context.newPage();
    try {
      await page.goto(sandboxes[1]!.origin + '/join');
      await page.getByRole('link', { name: /^Choose / }).first().click();
      await page.getByLabel('Contact or parent/guardian name', { exact: true }).fill('Riley Noscript');
      await page.getByLabel('Email', { exact: true }).fill(`noscript-${randomBytes(6).toString('hex')}@example.invalid`);
      await page.getByLabel('First name', { exact: true }).fill('Riley');
      await page.getByLabel('Last name', { exact: true }).fill('Noscript');
      await page.getByLabel('Date of birth', { exact: true }).fill('1994-05-06');
      // Everything the browser itself requires, so it sends the form; only the drawn signature is missing.
      for (const waiver of await page.locator('fieldset[data-waiver]:visible').all()) {
        await waiver.getByRole('combobox', { name: 'Who is signing?', exact: true }).selectOption({ label: 'I am this adult participant' });
        await waiver.getByLabel('Signer full name', { exact: true }).fill('Riley Noscript');
        await waiver.getByLabel('I have read and agree to this document.', { exact: true }).check();
      }
      await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
      await expect.poll(() => seen.filter((entry) => entry.path === '/join').length).toBeGreaterThan(0);
      await page.waitForLoadState();
      await report(browserName, `join-noscript-${name}`, page, seen, cspViolations);
      expect(await page.locator('body').innerText()).not.toMatch(/Content-Length required/i);
      expect(seen.find((entry) => entry.path === '/join')?.status, 'the form post reached the join handler').not.toBe(411);
    } finally { await context.close(); }
  });

  test(`CSV upload and preview at ${name} size`, async ({ browser, browserName, install, cspViolations }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    const seen = watch(context);
    await install.clients.owner.browser(context);
    const page = await context.newPage();
    try {
      const tag = randomBytes(3).toString('hex');
      const csv = 'externalId,firstName,lastName,email,householdExternalId,householdName,status\n'
        + `ux-${browserName}-${name}-${tag},Sam,Upload${tag},,ux-${tag},Upload family,active\n`;
      await page.goto(gymOrigin + '/admin/imports');
      await page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true }).setInputFiles({ name: `ux-${browserName}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('cell', { name: new RegExp('Upload' + tag) })).toBeVisible();
      await page.getByRole('button', { name: 'Dry run', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Dry run: Complete', { timeout: 30_000 });
      await report(browserName, `upload-${name}`, page, seen, cspViolations);
      expect(seen.map((entry) => entry.path)).toContain('/api/imports/uploads');
      expect(seen.filter((entry) => entry.status === null || entry.status >= 400), 'every bounded request was accepted').toEqual([]);
    } finally { await context.close(); }
  });
}
