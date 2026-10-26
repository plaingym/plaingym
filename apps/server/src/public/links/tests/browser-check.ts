// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTranslator } from '@plaingym/shared';
import type { PortalSignedLinkData } from '@plaingym/shared/contracts';
import { linkPage } from '../page.js';
import { buildLinkAssets } from '../styles.build.mjs';
import messages from '../../../../../../locales/en/public/links.json' with { type: 'json' };
import { validateSignatureImage } from '../../../areas/waivers/snapshot.js';

const output = resolve('coverage/signed-links/browser');
// Optional browser tooling is installed separately in e2e; normal type checks need no browser install.
const { chromium } = await import(new URL('../../../../../../e2e/node_modules/@playwright/test/index.mjs', import.meta.url).href);
await mkdir(output, { recursive: true });
await buildLinkAssets(output);
const css = await readFile(resolve(output, 'links.css'), 'utf8');
const browserSource = await readFile(resolve(output, 'links.js'), 'utf8');
const t = createTranslator({ 'public/links': messages }), now = new Date('2026-10-25T12:00:00Z');
const member = { id: 'member', firstName: 'Alex', lastName: 'Example', dateOfBirth: '2015-04-01', revision: 1 };
const templates = [{ id: 'template', name: 'Participation waiver', body: 'Please read these terms before signing.\n' + 'Training involves physical activity. '.repeat(100), version: 1, kind: 'waiver' as const, retiredAt: null, createdAt: now.toISOString() },
  { id: 'agreement', name: 'Training agreement', body: 'Please review the training agreement.', version: 1, kind: 'agreement' as const, retiredAt: null, createdAt: now.toISOString() }];
const fixtures: Record<string, PortalSignedLinkData> = {
  pay_invoice: { purpose: 'pay_invoice', invoice: { invoice: { id: 'invoice', number: 1, kind: 'one_off', status: 'open', dueOn: '2026-10-25', amountCents: 10000, currency: 'USD', paidAt: null },
    lines: [{ id: 'line', kind: 'charge', description: 'Training fees with a long description that wraps on a phone', amountCents: 10000, currency: 'USD', quantity: 1, taxInclusive: null, taxRateMillionths: null }] } },
  update_card: { purpose: 'update_card', paymentMethods: [] },
  sign_waiver: { purpose: 'sign_waiver', member, templates, signatures: [] },
  onboarding: { purpose: 'onboarding', members: [member], templates, signatures: [], paymentMethods: [] },
};
const errors: string[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/l/styles.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
  if (url.pathname === '/l/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(browserSource); return; }
  if (req.method === 'POST') {
    // Browser-only fixtures model persisted signatures and confirmed card setup;
    // production authorization, snapshots and completion are exercised in links.test.ts.
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { templateId?: string; pngBase64?: string };
    const purpose = url.pathname.includes('sign-waiver') ? 'sign_waiver' : 'onboarding';
    const data = fixtures[purpose]!;
    if (!('signatures' in data)) throw new Error('Missing signing fixture');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/signature-images')) {
      validateSignatureImage(Buffer.from(input.pngBase64!, 'base64'));
      res.end(JSON.stringify({ data: { signatureImageKey: 'fixture.png', signatureImageHash: 'fixture' } })); return;
    }
    if (url.pathname.endsWith('/complete')) {
      res.end(JSON.stringify({ data: { completed: data.signatures.length === templates.length } })); return;
    }
    data.signatures.push({ id: input.templateId!, memberId: member.id, templateId: input.templateId!, signedAt: now.toISOString(),
      snapshot: '', snapshotHash: '', signatureImageKey: '', signatureImageHash: '' });
    res.end(JSON.stringify({ data: {} })); return;
  }
  res.setHeader('content-type', 'text/html');
  if (url.pathname === '/l/cleared') { res.end(linkPage({ state: 'cleared', now, timezone: 'UTC', t })); return; }
  if (url.pathname === '/l/sign_waiver' && fixtures.sign_waiver?.purpose === 'sign_waiver' && fixtures.sign_waiver.signatures.length === templates.length) {
    res.end(linkPage({ state: 'alreadyDone', now, timezone: 'UTC', t, tablet: url.searchParams.has('tablet') })); return;
  }
  res.end(linkPage({ data: fixtures[url.pathname.split('/')[2] ?? ''] ?? fixtures.onboarding!, now, timezone: 'UTC', t, tablet: url.searchParams.has('tablet') }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
const origin = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error: Error) => errors.push(error.message));
  for (const width of [360, 1280]) for (const name of Object.keys(fixtures)) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/l/' + name);
    await page.waitForLoadState('networkidle');
    if (errors.length) throw new Error(errors.join('\n'));
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      shortControls: [...document.querySelectorAll<HTMLElement>('button, input:not([type="checkbox"]), select, a')]
        .filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 44).map(el => el.textContent ?? el.tagName),
    }));
    if (metrics.overflow || metrics.shortControls.length) throw new Error(name + ' ' + width + ': ' + JSON.stringify(metrics));
    await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(origin + '/l/sign_waiver?tablet=1');
  await page.getByLabel('Full name of signer').first().fill('A parent');
  await page.getByLabel('Relationship to member').first().fill('Parent');
  const canvas = page.locator('canvas').first(); await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Missing signature canvas');
  await page.mouse.move(bounds.x + 20, bounds.y + 40); await page.mouse.down();
  await page.mouse.move(bounds.x + 180, bounds.y + 100, { steps: 12 }); await page.mouse.up();
  const image = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  if (!image.startsWith('data:image/png;base64,')) throw new Error('Signature capture failed');
  validateSignatureImage(Buffer.from(image.split(',')[1]!, 'base64'));
  const ink = await canvas.evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
  if (!ink) throw new Error('Signature drawing produced no ink');
  await page.getByRole('link', { name: 'Finish and clear screen' }).click();
  await page.waitForURL('**/l/cleared');
  if ((await page.content()).includes('A parent')) throw new Error('Tablet retained signer details');
  for (const width of [360, 1280]) for (const purpose of ['sign_waiver', 'onboarding']) {
    const data = fixtures[purpose]!; if (!('signatures' in data)) throw new Error('Missing signing fixture');
    data.signatures = [];
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/l/' + purpose + '?tablet=1');
    for (let index = 0; index < 2; index++) {
      const form = page.locator('form[data-waiver]').first();
      await form.getByLabel('Full name of signer').fill('A parent');
      await form.getByLabel('Relationship to member').fill('Parent');
      const pad = form.locator('canvas'); await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox(); if (!box) throw new Error('Missing signature canvas');
      await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down();
      await page.mouse.move(box.x + 180, box.y + 100, { steps: 12 }); await page.mouse.up();
      await form.locator('[name="consent"]').check();
      await Promise.all([page.waitForEvent('load'), form.locator('[type="submit"]').click()]);
      if (index === 0) {
        await page.waitForLoadState('networkidle');
        if (!page.url().includes('/l/' + purpose) || await page.locator('form[data-waiver]').count() !== 1)
          throw new Error('First signature consumed the link or hid the second document');
        await page.screenshot({ path: resolve(output, `${purpose}-second-document-${width}.png`), fullPage: true });
      }
    }
    if (purpose === 'onboarding') {
      await page.waitForLoadState('networkidle');
      if (await page.locator('form[data-waiver]').count() !== 0) throw new Error('Onboarding did not retain both signatures');
      await page.locator('[data-complete]').click();
    }
    await page.waitForURL('**/l/cleared');
    if (data.signatures.length !== 2) throw new Error('Missing persisted fixture signatures');
  }
  await page.clock.install();
  await page.goto(origin + '/l/onboarding?tablet=1');
  await page.clock.fastForward(121_000);
  await page.waitForURL('**/l/cleared');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Passed: four screens at 360 px and desktop, 44 px controls, signature drawing, two-template waiver/onboarding flows at both widths, tablet clear and inactivity reset.');
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
