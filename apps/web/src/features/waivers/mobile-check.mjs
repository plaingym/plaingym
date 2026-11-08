// SPDX-License-Identifier: AGPL-3.0-only
/* global document, window */
// Run against Vite on an isolated port; install the existing e2e dependencies first.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../../../e2e/package.json', import.meta.url));
const { chromium, firefox, webkit, expect } = require('@playwright/test');
const { default: AxeBuilder } = require('@axe-core/playwright');
const serverRequire = createRequire(new URL('../../../../../apps/server/package.json', import.meta.url));
const PDFKit = serverRequire('pdfkit'), pdfChunks = [];
const pdfSource = new PDFKit();
pdfSource.on('data', chunk => pdfChunks.push(chunk));
const pdfReady = new Promise(resolve => pdfSource.on('end', resolve));
pdfSource.text('Synthetic uploaded waiver for browser layout checks.'); pdfSource.end();
await pdfReady;
const pdfBytes = Buffer.concat(pdfChunks);
const output = new URL('../../../../../coverage/waivers/', import.meta.url); await mkdir(output, { recursive: true });
const engineName = process.argv[3] ?? 'edge';
const engine = { edge: chromium, firefox, webkit }[engineName];
if (!engine) throw new Error('Choose edge, firefox or webkit');
const browser = await engine.launch({ headless: true, ...(engineName === 'edge' ? { channel: 'msedge' } : {}) });
const id = '01900000-0000-7000-8000-000000000001';
const template = { id, name: 'Participation agreement', kind: 'agreement', version: 2, body: 'Read these terms before signing.\n山田太郎 王小明 김민수\nأحمد محمد 12345', retiredAt: null, createdAt: '2026-10-24T12:00:00Z' };
const unsigned = { ...template, id: '01900000-0000-7000-8000-000000000003', name: 'New participation terms', version: 3 };
const documentReference = { key: id + '/waivers/templates/' + id + '.pdf', hash: 'c'.repeat(64), pages: 1, bytes: pdfBytes.length };
const pdfTemplate = { ...template, body: '', document: documentReference };
const snapshot = { template: { id, name: template.name, kind: template.kind, version: 2, body: template.body },
  member: { id, firstName: 'Ava', lastName: 'Chen', dateOfBirth: '2018-01-01' }, signer: { kind: 'guardian', name: 'Daniel Chen', relationship: 'Parent' },
  signedAt: '2026-10-24T01:30:00Z', signatureImage: { key: id + '/test.png', hash: 'a'.repeat(64) } };
const signature = { id: '01900000-0000-7000-8000-000000000002', memberId: id, templateId: id, snapshot: JSON.stringify(snapshot),
  snapshotHash: 'b'.repeat(64), signatureImageKey: snapshot.signatureImage.key, signatureImageHash: snapshot.signatureImage.hash, signedAt: snapshot.signedAt };
const mutations = [];
try {
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    let demo = true, pdf = false, documentReads = 0, documentFailure = false;
    await page.clock.install();
    page.setDefaultTimeout(10_000);
    await page.route('**/api/waivers/**', async route => {
      const request = route.request(), url = request.url();
      if (url.includes('/template-document?')) return route.fulfill({ body: pdfBytes, contentType: 'application/pdf', headers: {
        'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
      } });
      if (url.endsWith('/document')) {
        documentReads++;
        if (documentFailure) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Retry later' } } });
        return route.fulfill({ json: { data: { url: new URL('/api/waivers/template-document?token=fixture' + documentReads, url).href, expiresAt: new Date(Date.now() + 300_000).toISOString() } } });
      }
      if (url.endsWith('/template-documents')) return route.fulfill({ json: { data: documentReference } });
      if (request.method() === 'POST') {
        mutations.push({ url, body: request.postDataJSON() });
        if (url.endsWith('signature-images')) return demo
          ? route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Uploads are disabled in the demo' } } })
          : route.fulfill({ json: { data: { signatureImageKey: id + '/test.png', signatureImageHash: 'a'.repeat(64) } } });
        return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Template changed; review the current version' } } });
      }
      if (url.endsWith('/pdf')) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'PDF renderer busy; retry shortly' } } });
      const filter = new URL(url).searchParams.get('templateId');
      const data = url.includes('/templates') ? [pdf ? pdfTemplate : template, unsigned] : filter && filter !== id ? [] : [signature];
      return route.fulfill({ json: { data, pagination: { limit: 20, offset: 0, total: data.length } } });
    });
    const check = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const small = await page.locator('button:visible, input:not([type=checkbox]):visible, select:visible').evaluateAll(elements => elements
        .filter(el => !el.closest('[inert]') && (!document.querySelector('dialog[open]') || el.closest('dialog')))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(el => el.outerHTML));
      expect(small).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL(`${engineName}-${width}-${name}.png`, output)), fullPage: true });
    };
    const closeDialog = async () => {
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
      const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
      if (await discard.isVisible()) await discard.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await page.goto((process.argv[2] ?? 'http://127.0.0.1:5194') + '/src/features/waivers/browser-fixture.html');
    await page.getByRole('button', { name: 'Edit template' }).first().waitFor();
    await expect(page.getByText('Signed — current version', { exact: true })).toBeVisible();
    await expect(page.getByText('Needs a signature', { exact: true })).toBeVisible();
    await expect(page.getByText('Guardian signature: Daniel Chen (Parent)', { exact: true })).toBeVisible();
    await expect(page.locator('time')).toHaveText(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.signedAt)));
    await page.getByRole('button', { name: 'Prepare PDF' }).click();
    await expect(page.getByText('PDF renderer busy; retry shortly')).toBeVisible();
    await check('list');
    await page.getByRole('button', { name: 'Edit template' }).first().click();
    await page.getByLabel('Agreement text').fill('New terms'); await check('editor');
    await page.getByRole('button', { name: 'Publish version' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Template changed; review the current version');
    await closeDialog();
    await page.getByRole('button', { name: 'Review and sign' }).first().click();
    await page.getByLabel('I am signing as a parent or guardian').check();
    await page.getByLabel('Signer’s full name').fill('Daniel Chen');
    await page.getByLabel('Relationship to member').fill('Parent');
    await page.getByLabel('Use my typed name as my signature').check();
    await page.getByLabel('I have read this text and agree to sign it electronically.').check();
    await check('signing'); await page.getByRole('button', { name: 'Sign agreement', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Uploads are disabled in the demo');
    await check('demo-error'); demo = false;
    await page.getByRole('button', { name: 'Sign agreement', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Template changed; review the current version');
    await check('stale-error');
    const signed = mutations.filter(m => m.url.endsWith('/signatures')).at(-1);
    expect(signed.body.signer).toEqual({ kind: 'guardian', name: 'Daniel Chen', relationship: 'Parent' });
    const upload = mutations.filter(m => m.url.endsWith('/signature-images')).at(-1);
    await writeFile(new URL(`${engineName}-${width}-signature.png`, output), Buffer.from(upload.body.pngBase64, 'base64'));
    pdf = true;
    await page.reload();
    await page.getByRole('button', { name: 'Edit template' }).first().click();
    await expect(page.getByLabel('Document format')).toHaveValue('pdf');
    await page.getByLabel('Upload a PDF').setInputFiles({ name: 'waiver.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
    await expect(page.getByRole('status')).toContainText('PDF uploaded and validated.');
    await check('pdf-editor');
    await closeDialog();
    await page.getByRole('button', { name: 'Review and sign' }).first().click();
    await expect(page.getByRole('link', { name: 'Open the document' })).toBeVisible();
    await expect(page.getByLabel('I have read this document and agree to sign it electronically.')).toHaveAttribute('required');
    await check('pdf-signing');
    const preview = await page.locator('iframe').getAttribute('src'), reads = documentReads;
    const setVisibility = state => page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value });
      window.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await setVisibility('visible');
    expect(documentReads).toBe(reads);
    await setVisibility('hidden');
    await page.clock.fastForward(240_001);
    expect(documentReads).toBe(reads);
    await setVisibility('visible');
    await expect(page.getByRole('link', { name: 'Open the document' })).not.toHaveAttribute('href', preview);
    await expect(page.locator('iframe')).toHaveAttribute('src', preview);
    documentFailure = true;
    await page.clock.fastForward(240_001);
    await expect.poll(() => documentReads).toBeGreaterThan(reads + 1);
    await expect(page.locator('iframe')).toHaveAttribute('src', preview);
    await expect(page.getByRole('button', { name: 'Sign agreement', exact: true })).toBeEnabled();
    await expect(page.getByLabel('I have read this document and agree to sign it electronically.')).not.toBeChecked();
    await check('pdf-refresh-error');
    await page.route('**/api/portal/**/document', route => route.fulfill({ json: { householdId: id,
      data: { url: new URL('/api/waivers/template-document?token=fixture', route.request().url()).href, expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.goto((process.argv[2] ?? 'http://127.0.0.1:5194') + '/src/features/waivers/browser-fixture.html?portal=1');
    await expect(page.getByRole('link', { name: 'Open the document' })).toBeVisible();
    await expect(page.locator('input[type=checkbox][required]')).toHaveCount(1);
    await check('pdf-portal');
    await context.close();
  }
  console.log(`Waiver screens (${engineName}): 360px and 1280px, editor/signing flows, 44px controls, overflow and axe passed.`);
} finally { await browser.close(); }
