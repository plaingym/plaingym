// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, demoClient, test, createClass, localDate, showPortalClass, type RecordId } from '../support.js';
import { accessibleThemes, keyboardActivate, tabTo } from '../responsive.js';
import { stripeOrigin } from '../portal.js';
import { viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

/** The demo fixture's S3 hostname is internal; pass the bearer URL on stdin, keeping it out of errors. */
async function receiptBytes(href: string) {
  expect(new URL(href).origin).toBe('http://demo-s3:7070');
  const code = "try { let href = ''; for await (const chunk of process.stdin) href += chunk; "
    + "const response = await fetch(href, { signal: AbortSignal.timeout(15000) }); const bytes = Buffer.from(await response.arrayBuffer()); "
    + "console.log(JSON.stringify({ status: response.status, contentType: response.headers.get('content-type'), pdf: bytes.subarray(0, 5).toString() === '%PDF-' })); "
    + "} catch { process.exitCode = 1; }";
  return new Promise<{ status: number; contentType: string; pdf: boolean }>((resolve, reject) => {
    const child = execFile('docker', ['compose', '--project-name', process.env.E2E_COMPOSE_PROJECT!, '--file', 'compose.yaml',
      'exec', '-T', 'demo', 'node', '--input-type=module', '--eval', code],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 30_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) { reject(new Error('Internal receipt download failed')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid receipt download evidence')); }
    });
    child.stdin!.on('error', () => reject(new Error('Internal receipt download input failed')));
    child.stdin!.end(href);
  });
}

for (const { name: size, viewport } of viewports) {
  test(`portal booking, payment and dialog focus by keyboard alone at ${size} width`, async ({ page, context, sandboxes }, info) => {
    const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
    const session = await createClass(owner, 'Keyboard class ' + size);
    const household = (await student.json<{ data: RecordId }>('/api/portal/household')).data;
    const invoice = (await owner.json<{ data: RecordId & { number: string } }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id,
      dueOn: localDate(new Date(), 'UTC'), source: 'custom', description: 'Keyboard payment', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
    await student.browser(context);
    await page.setViewportSize(viewport);
    await page.goto(sandbox.origin + '/portal/schedule');
    await showPortalClass(page, page.getByRole('button', { name: new RegExp('^Book ' + session.name + ' for ') }));
    await keyboardActivate(page, page.getByRole('button', { name: new RegExp('^Book ' + session.name + ' for ') }));
    const cancel = page.getByRole('button', { name: new RegExp('^Cancel booking: ' + session.name + ' for ') });
    await expect(cancel).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /is booked/ })).toBeVisible();
    await keyboardActivate(page, cancel);
    await expect(page.getByRole('status').filter({ hasText: /is cancelled/ })).toBeVisible();
    await accessibleThemes(page, info, size + '-keyboard-booking');

    await page.goto(sandbox.origin + '/portal/household');
    const edit = page.getByRole('button', { name: 'Edit details', exact: true }).first();
    await keyboardActivate(page, edit);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i < 20 ? 'Tab' : 'Shift+Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'dialog contains keyboard focus').toBe(true);
    }
    await accessibleThemes(page, info, size + '-keyboard-profile-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(edit).toBeFocused();

    await page.goto(sandbox.origin + '/portal/billing');
    const bill = page.getByRole('listitem').filter({ hasText: 'Invoice #' + invoice.number });
    await keyboardActivate(page, bill.getByRole('button', { name: 'Pay now', exact: true }));
    await page.waitForURL(url => url.origin === stripeOrigin);
    await tabTo(page, page.getByLabel('Card number', { exact: true }));
    await page.keyboard.insertText('4242 4242 4242 4242');
    await keyboardActivate(page, page.getByRole('button', { name: 'Pay', exact: true }));
    await page.waitForURL(url => url.origin === sandbox.origin && url.pathname.startsWith('/l/'));
    await expect(page.locator('main h1')).toBeVisible();
    await accessibleThemes(page, info, size + '-keyboard-payment-return');
    const bankLabel = 'Example Bank account ending 6789';
    await page.route('**/api/portal/payment-methods', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data = [{ id: crypto.randomUUID(), type: 'us_bank_account', bankName: 'Example Bank', brand: null, last4: '6789',
        expiryMonth: null, expiryYear: null, isDefault: true }];
      await route.fulfill({ response, json: body });
    });
    await page.goto(sandbox.origin + '/portal/billing');
    const bank = page.getByRole('listitem').filter({ hasText: bankLabel });
    await expect(bank.getByText('Default payment method', { exact: true })).toBeVisible();
    await expect(bank.getByText(/expir/i)).toHaveCount(0);
    await accessibleThemes(page, info, size + '-portal-payment-methods');
    // Fake Checkout does not dispatch payment webhooks here; use an already paid sandbox invoice.
    await keyboardActivate(page, page.getByRole('button', { name: 'Download receipt', exact: true }).first());
    const receipt = page.getByRole('link', { name: 'Open receipt', exact: true });
    await expect(receipt).toBeVisible();
    const pdf = await receiptBytes((await receipt.getAttribute('href'))!);
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toContain('application/pdf');
    expect(pdf.pdf).toBe(true);
    await accessibleThemes(page, info, size + '-keyboard-receipt');
    await keyboardActivate(page, page.getByRole('button', { name: /^(Add a card|Update card)$/ }));
    await page.waitForURL(url => url.origin === stripeOrigin);
  });
}
