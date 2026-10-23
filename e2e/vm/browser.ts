// SPDX-License-Identifier: AGPL-3.0-only
import { expect as baseExpect, type BrowserType, type Page, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config, Target } from './host.js';

export const owner = { name: 'VM QA Owner', email: 'vm-owner@example.invalid', password: 'VM-qa-passwÅrd-2026' };
const expect = baseExpect.configure({ timeout: 60_000 });
export async function browserFor(type: BrowserType, config: Config, target: Target) {
  const browser = await type.launch({
    channel: process.env.E2E_BROWSER_CHANNEL,
    args: ['--no-proxy-server', ...(target.address ? ['--host-resolver-rules=MAP ' + new URL(target.url).hostname + ' ' + target.address + (target.connectPort ? ':' + target.connectPort : '')] : [])]
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: Boolean(config.localFixture), viewport: { width: 1024, height: 900 } });
  context.setDefaultTimeout(60_000);
  context.setDefaultNavigationTimeout(60_000);
  return { browser, context, page: await context.newPage() };
}
export async function api<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    if(!response.ok) throw new Error('QA read failed: ' + path + ' ' + response.status);
    return response.json();
  }, path) as Promise<T>;
}
export async function login(page: Page, url: string) {
  await page.goto(url + '/login');
  const state = await api<{ data: { session: unknown } }>(page, '/api/auth/bootstrap');
  if(state.data.session) { await expect(page).toHaveURL(/\/admin/); return; }
  await page.getByLabel('Email address', { exact: true }).fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/admin/);
}
export async function guards(context: BrowserContext, target: Target) {
  const page = await context.newPage();
  await page.goto(target.url + '/setup');
  const statuses = await page.evaluate(async () => {
    const results: number[] = [];
    for(const path of ['/api/setup/start', '/api/setup/owner', '/api/setup/restore', '/api/setup/restore/019a0000-0000-7000-8000-000000000000']) {
      const response = await fetch(path, {
        method: path.includes('/restore/') ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' }, body: path.includes('/restore/') ? undefined : '{}'
      });
      results.push(response.status);
    }
    return results;
  });
  expect(statuses).toEqual([403, 403, 403, 403]);
  await page.close();
}
async function destination(page: Page, config: Config) {
  for(const [label, value] of [
    ['S3-compatible endpoint URL', config.s3.endpoint], ['Storage region', config.s3.region],
    ['Storage bucket', config.s3.bucket], ['Storage access key ID', config.s3.accessKeyId],
    ['Storage secret access key', config.s3.secretAccessKey],
  ]) await page.getByLabel(label, { exact: true }).fill(value);
}
const next = (page: Page) => page.getByRole('button', { name: 'Save and continue', exact: true }).click();
export interface Witness { memberId: string; photoSha256: string; snapshotId: string; privateKey: string; gymName: string }
export async function wizard(page: Page, config: Config, setupLink: string): Promise<Omit<Witness, 'snapshotId'>> {
  await page.goto(setupLink);
  const probe = await page.evaluate(async () => { const response = await fetch('/api/setup'); return { status: response.status, body: await response.json() }; });
  if(probe.status === 404 && config.resume) {
    const draft = JSON.parse(await readFile(resolve(config.artifacts, 'witness-draft.json'), 'utf8')) as Omit<Witness, 'snapshotId'>;
    await login(page, config.source.url);
    expect((await api<{ data: { name: string } }>(page, '/api/settings')).data.name === draft.gymName).toBe(true);
    expect(await photoDigest(page, draft.memberId) === draft.photoSha256).toBe(true);
    return draft;
  }
  expect(probe.status).toBe(200);
  const initial = probe.body as { data: { currentStep: number } };
  const step = initial.data.currentStep;
  if(config.resume && step >= 2) {
    await login(page, config.source.url);
    await page.goto(setupLink);
  }
  if(config.resume && step === 8) {
    const draft = JSON.parse(await readFile(resolve(config.artifacts, 'witness-draft.json'), 'utf8')) as Omit<Witness, 'snapshotId'>;
    await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Setup is complete.');
    return draft;
  }
  if(step === 0) {
    await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  }
  if(step <= 1) {
    await page.getByLabel('Your name', { exact: true }).fill(owner.name);
    await page.getByLabel('Email address', { exact: true }).fill(owner.email);
    await page.getByLabel('Password (12–128 characters)', { exact: true }).fill(owner.password);
    await next(page);
  }
  let gymName = 'VM QA Academy ' + Date.now();
  if(step <= 2) {
    await page.getByLabel('Gym name', { exact: true }).fill(gymName);
    await page.getByLabel('IANA timezone', { exact: true }).fill('America/Vancouver');
    await next(page);
  } else {
    gymName = (await api<{ data: { name: string } }>(page, '/api/settings')).data.name;
  }
  if(step <= 3) {
    await expect(page.getByRole('heading', { name: 'What do you teach?', exact: true })).toBeVisible();
    await page.locator('input[name=packs][value=bjj]').check();
    await next(page);
  }
  if(step <= 4) {
    await page.getByRole('radio', { name: 'I already have a website', exact: true }).check();
    await next(page);
  }
  if(step <= 5) {
    await page.getByRole('button', { name: 'Skip email configuration', exact: true }).click();
  }
  if(step <= 6) {
    // Payments are configured later from settings; the registered Stripe step offers this choice.
    await page.getByRole('button', { name: 'Set up later', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate backup key', exact: true })).toBeVisible();
  }
  // Populate a second tab before confirming backups. The first unattended
  // snapshot must contain the witness, even on a slow guest.
  const witnessPage = await page.context().newPage();
  const { memberId, photoSha256 } = await createWitness(witnessPage, config.source.url);
  await witnessPage.close();
  await destination(page, config);
  await page.getByRole('button', { name: 'Generate backup key', exact: true }).click();
  const privateKey = (await page.locator('pre').textContent())!.trim();
  expect(privateKey.startsWith('AGE-SECRET-KEY-1')).toBe(true);
  await writeFile(resolve(config.artifacts, 'witness-draft.json'), JSON.stringify({ memberId, photoSha256, privateKey, gymName }), { mode: 0o600 });
  await page.getByLabel('Backup private key', { exact: true }).fill(privateKey);
  await page.getByRole('checkbox', { name: 'I saved my private key somewhere safe', exact: true }).check();
  await page.getByRole('button', { name: 'Confirm saved key', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import or start fresh', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Setup is complete.');
  return { memberId, photoSha256, privateKey, gymName };
}
async function createWitness(page: Page, url: string) {
  await page.goto(url + '/admin/members');
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  const members = await api<{ data: { id: string; firstName: string; lastName: string }[] }>(page, '/api/members?search=VM&limit=100');
  const existing = members.data.find(member => member.firstName === 'VM' && member.lastName === 'River');
  if(existing) {
    const memberId = existing.id;
    await page.goto(url + '/admin/members/' + memberId);
    await expect(page.getByRole('img', { name: 'Member photo', exact: true })).toBeVisible();
    return { memberId, photoSha256: await photoDigest(page, memberId) };
  }
  await page.goto(url + '/admin/imports');
  await page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true }).setInputFiles({
    name: 'vm-witness.csv', mimeType: 'text/csv',
    buffer: Buffer.from('externalId,firstName,lastName,email\nvm-qa-river,VM,River,vm-member@example.invalid\n')
  });
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dry run: Complete', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Commit import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Import CSV: Complete', { timeout: 120_000 });
  await page.goto(url + '/admin/members');
  await page.getByRole('link', { name: 'VM River', exact: true }).click();
  const memberId = new URL(page.url()).pathname.split('/').at(-1)!;
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#4169e1'; ctx.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Upload photo', { exact: true }).setInputFiles({ name: 'vm-qa.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('img', { name: 'Member photo', exact: true })).toBeVisible();
  const photoSha256 = await photoDigest(page, memberId);
  return { memberId, photoSha256 };
}
export async function photoDigest(page: Page, memberId: string) {
  const bytes = await page.evaluate(async (id) => {
    const response = await fetch('/api/members/' + id + '/photo');
    if(!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Member photo was not served');
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, memberId);
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
export async function restoreWizard(page: Page, config: Config, link: string, witness: Witness) {
  await page.goto(link);
  await page.getByRole('button', { name: 'Restore a backup', exact: true }).click();
  await destination(page, config);
  await page.getByLabel('Snapshot ID or snapshots/ID/ prefix', { exact: true }).fill(witness.snapshotId);
  await page.getByLabel('Backup private key', { exact: true }).fill(witness.privateKey);
  await page.getByRole('button', { name: 'Restore a backup', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Backup restored.', { timeout: 240_000 });
  await login(page, config.restore.url);
  await verifyRestored(page, config, witness);
}
export async function verifyRestored(page: Page, config: Config, witness: Witness) {
  const settings = await api<{ data: { name: string } }>(page, '/api/settings');
  expect(settings.data.name === witness.gymName).toBe(true);
  const switches = await api<{ data: { billingEnabled: boolean; memberEmailsEnabled: boolean } }>(page, '/api/settings/go-live');
  expect(switches.data).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
  await page.goto(config.restore.url + '/admin/members/' + witness.memberId);
  await expect(page.getByRole('heading', { name: 'VM River', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Member photo', exact: true })).toBeVisible();
  expect(await photoDigest(page, witness.memberId) === witness.photoSha256).toBe(true);
}
