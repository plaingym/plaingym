// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Billing, waiver and household pages in the built portal at 360 px and 1280 px, as a payer and as an adult member.
const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const output = resolve('coverage/portal/household-browser'), dist = resolve('apps/web/dist'); await mkdir(output, { recursive: true });
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ids = { gym: id(1), user: id(2), household: id(3), payer: id(4), child: id(5), adult: id(6), invoice: id(7), paid: id(8), template: id(9), signature: id(10) };
const bootstrap = { gym: { id: ids.gym, name: 'A long gym name that must fit on a phone', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: ids.user, roles: [], member: true }, login: { password: true, magicLink: false } };
const person = (memberId: string, firstName: string, dateOfBirth: string | null) => ({ id: memberId, firstName, lastName: 'Rivera-Montgomery', email: firstName.toLowerCase() + '.a.long.address@example.test',
  phone: '555-0100', dateOfBirth, photoKey: null, status: 'active', emergencyContacts: [{ name: 'Grandparent with a long name', relationship: null, phone: '555-0101' }], revision: 1 });
// Jordan is an imported adult with no recorded birth date: shown, but the payer may not edit or sign for them.
const people = [person(ids.payer, 'Pat', '1980-04-02'), person(ids.child, 'Kim', '2016-06-01'), person(ids.adult, 'Alex', '1990-01-01'), person(id(11), 'Jordan', null)];
const list = <T>(data: T[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });
const invoice = (invoiceId: string, number: number, status: string, paidAt: string | null) => ({ id: invoiceId, number, kind: 'cycle', status, dueOn: '2026-10-20', amountCents: 12_500, currency: 'USD', paidAt });
const template = { id: ids.template, name: 'Participation waiver and release of liability', kind: 'waiver', version: 3, body: 'I agree to the terms.\n'.repeat(20), retiredAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
const snapshot = JSON.stringify({ template: { id: ids.template, name: template.name, kind: 'waiver', version: 3, body: 'I agree.' },
  member: { id: ids.child, firstName: 'Kim', lastName: 'Rivera-Montgomery', dateOfBirth: '2016-06-01' }, signer: { kind: 'guardian', name: 'Pat Rivera-Montgomery', relationship: 'Parent' },
  signedAt: '2026-10-02T00:00:00.000Z', commitmentEndsOn: null, signatureImage: { key: 'k', hash: 'a'.repeat(64) } });
const signature = { id: ids.signature, memberId: ids.child, templateId: ids.template, snapshot, snapshotHash: 'b'.repeat(64), signatureImageKey: 'k', signatureImageHash: 'a'.repeat(64), signedAt: '2026-10-02T00:00:00.000Z' };
let role: 'payer' | 'member' = 'payer';
const api = (path: string): unknown => {
  const self = role === 'member';
  if (path === '/api/demo') return { data: { mode: 'disabled' } };
  if (path === '/api/auth/bootstrap') return { data: bootstrap };
  if (path === '/api/portal/households') return { data: { current: ids.household, households: [{ householdId: ids.household, name: 'Rivera household', role }] } };
  if (path === '/api/portal/context') return { data: self ? { role, householdId: ids.household, memberId: ids.adult } : { role, householdId: ids.household, memberId: ids.payer } };
  if (path === '/api/portal/invoices') return list([invoice(ids.invoice, 1042, 'past_due', null), invoice(ids.paid, 1041, 'partially_refunded', '2026-09-21T10:00:00.000Z')]);
  if (path === `/api/portal/invoices/${ids.invoice}`) return { data: { invoice: invoice(ids.invoice, 1042, 'past_due', null), lines: [
    { id: id(20), kind: 'membership', description: 'Unlimited adult membership with a long plan name', amountCents: 10_000, currency: 'USD', quantity: 1, taxRateMillionths: null, taxInclusive: null },
    { id: id(21), kind: 'tax', description: 'Sales tax', amountCents: 2500, currency: 'USD', quantity: 1, taxRateMillionths: 25_000, taxInclusive: false }] } };
  if (path === '/api/portal/payment-methods') return { data: [{ id: id(30), brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2029, isDefault: true }, { id: id(31), brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: false }] };
  if (path === '/api/portal/household') return { data: { id: ids.household, name: 'Rivera household', email: 'payer@example.test', phone: null, address: { line1: '1 Main St', city: 'Springfield', countryCode: 'US' }, billingDay: 1, revision: 1 } };
  if (path === '/api/portal/members') return list(people);
  if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
  if (path.endsWith('/memberships')) return list([{ id: id(40), memberId: ids.child, planId: id(41), status: 'active', interval: 'monthly', startsOn: '2026-01-01', nextDueOn: '2026-11-01', trialEndsOn: null, commitmentEndsOn: null, revision: 1 }]);
  if (path === '/api/portal/household/waivers/pending') return list([{ memberId: ids.child, template }, { memberId: ids.payer, template }, { memberId: id(11), template }]);
  if (path === '/api/portal/household/waivers') return list([signature]);
  if (path === '/api/portal/waivers/pending') return list([{ memberId: ids.adult, template }]);
  if (path === '/api/portal/waivers') return list([]);
  return undefined;
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    const body = api(path); res.setHeader('Content-Type', 'application/json');
    if (body === undefined) res.statusCode = 404;
    res.end(JSON.stringify(body ?? { error: { code: 'not_found', message: 'Not found' } })); return;
  }
  if (path.startsWith('/assets/')) { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve(dist, 'assets', path.split('/').at(-1)!))); return; }
  if (path.startsWith('/portal/') && /\.(js|webmanifest|png)$/.test(path)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html')));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
const profile = await mkdtemp(resolve(output, 'profile-'));
if (!profile.startsWith(output + sep)) throw new Error('Unexpected profile directory');
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button,input,select,a')].filter(element => !element.classList.contains('sr-only') && element.getClientRects().length
        && element.getBoundingClientRect().height < 44 && !(element instanceof HTMLInputElement && element.type === 'checkbox')).map(element => element.outerHTML.slice(0, 120))), name).toEqual([]);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations, name).toEqual([]);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
    };
    role = 'payer';
    await page.goto(origin + '/portal/billing'); await expect(page.getByText('Invoice #1042')).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).first().click(); await expect(page.getByText('Sales tax')).toBeVisible();
    await check('billing-payer');
    await page.goto(origin + '/portal/waivers'); await expect(page.getByText('Signed by Pat Rivera-Montgomery (guardian)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review and sign' })).toHaveCount(2);
    await check('waivers-payer');
    await page.getByRole('button', { name: 'Review and sign' }).first().click(); await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Relationship to the member')).toBeVisible(); await check('sign-dialog');
    await page.getByRole('button', { name: 'Close' }).last().click();
    await page.goto(origin + '/portal/household'); await expect(page.getByRole('heading', { name: 'Household contact details' })).toBeVisible();
    await page.getByRole('button', { name: 'Show memberships' }).nth(1).click(); await expect(page.getByText('Monthly membership')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(2);
    await check('household-payer');
    await page.getByRole('button', { name: 'Edit details' }).nth(1).click(); await expect(page.getByRole('dialog')).toBeVisible(); await check('edit-dialog');
    await page.getByRole('button', { name: 'Close' }).last().click();
    if (width === 360) { await page.getByRole('button', { name: 'Menu' }).click(); await expect(page.getByRole('link', { name: 'Billing' })).toBeVisible(); await check('menu-payer'); }
    role = 'member';
    await page.goto(origin + '/portal/household'); await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(0); await check('household-member');
    await page.goto(origin + '/portal/waivers'); await expect(page.getByRole('button', { name: 'Review and sign' })).toBeVisible(); await check('waivers-member');
    if (width === 360) { await page.getByRole('button', { name: 'Menu' }).click(); await expect(page.getByRole('link', { name: 'Billing' })).toHaveCount(0); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Portal billing, waivers and household browser checks passed; screenshots in ' + output);
} finally {
  await browser.close(); server.close(); await rm(profile, { recursive: true, force: true });
}
