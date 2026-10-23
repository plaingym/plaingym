// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';

test('import → schedule → coach check-in → kiosk → promote persists across pages', async ({ page, browser, install }, info) => {
  test.setTimeout(150_000);
  const owner = install.clients.owner, coach = install.clients.coach;
  const people = () => owner.json<{ data: Person[] }>('/api/members?search=River&limit=100');
  const csv = 'externalId,firstName,lastName,email,householdExternalId,householdName,status\n'
    + 'qa-jamie,Jamie,River,jamie@example.invalid,qa-family,River family,active\n'
    + 'qa-robin,Robin,River,robin@example.invalid,qa-family,River family,active\n';
  await owner.browser(page.context());
  await page.goto(gymOrigin + '/admin/imports');
  await page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true }).setInputFiles({ name: 'qa-people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('qa-people.csv', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Jamie/ })).toBeVisible();
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dry run: Complete', { timeout: 30_000 });
  expect((await people()).data).toHaveLength(0);
  await page.getByRole('button', { name: 'Commit import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Import CSV: Complete', { timeout: 30_000 });
  const members = (await people()).data;
  expect(members).toHaveLength(2);
  const jamie = members.find((person) => person.firstName === 'Jamie')!, robin = members.find((person) => person.firstName === 'Robin')!;
  expect(robin.householdId).toBe(jamie.householdId);
  const home = await owner.json<{ data: RecordId }>('/api/households/' + jamie.householdId);
  await owner.json('/api/households/' + home.data.id + '/pin', 'PUT', { revision: home.data.revision, pin: '1357' });
  const switches = await owner.json<{ data: { billingEnabled: boolean; memberEmailsEnabled: boolean } }>('/api/settings/go-live');
  expect(switches.data).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });

  // The mat mapper supplies imported class history to the real eligibility provider.
  const rank = install.ranks[1];
  await owner.json('/api/ranks/' + rank.id, 'PATCH', { revision: rank.revision,
    criteria: [{ providerId: 'classes-since-promotion', config: { target: 2 } }] });
  const history = 'externalId,firstName,lastName,program,rank,promotedAt,occurredAt\n'
    + `qa-rank,Jamie,River,${install.program.name},${install.ranks[0].name},${new Date(Date.now() - 2 * 86_400_000).toISOString()},\n`
    + `qa-history,Jamie,River,${install.program.name},,,${new Date(Date.now() - 86_400_000).toISOString()}\n`;
  await page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true }).setInputFiles({ name: 'qa-mat.csv', mimeType: 'text/csv', buffer: Buffer.from(history) });
  await page.getByLabel('Import type').selectOption('mat');
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Dry run: Complete', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Commit import', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Import CSV: Complete', { timeout: 30_000 });

  const imported = await owner.json<{ data: { source: string; programId: string | null }[] }>('/api/attendance?memberId=' + jamie.id + '&source=import');
  expect(imported.data).toMatchObject([{ source: 'import', programId: install.program.id }]);
  await page.goto(gymOrigin + '/admin/schedule');
  await page.getByRole('button', { name: 'New one-off session', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'New one-off session', exact: true }) });
  await form.getByLabel('Name', { exact: true }).fill('QA evening class');
  const start = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 16);
  const end = new Date(Date.now() + 55 * 60_000).toISOString().slice(0, 16);
  await form.getByLabel('Starts at').fill(start);
  await form.getByLabel('Ends at').fill(end);
  await form.getByRole('checkbox', { name: install.program.name, exact: true }).check();
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/schedule/sessions') && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const session = (await response.json() as { data: RecordId & { programIds: string[] } }).data;
  expect(session.programIds).toEqual([install.program.id]);
  await expect(page.getByRole('button', { name: /QA evening class/ })).toBeVisible();

  await coach.browser(page.context());
  await page.reload();
  await page.getByRole('button', { name: /QA evening class/ }).click();
  const roster = page.getByRole('region', { name: 'Coach check-in roster', exact: true });
  await roster.getByRole('button', { name: 'Check in Jamie River', exact: true }).click();
  await expect(roster.getByRole('button', { name: 'Jamie River is checked in', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /QA evening class/ }).click();
  await expect(page.getByRole('button', { name: 'Jamie River is checked in', exact: true })).toBeDisabled();

  const kioskContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 768, height: 1024 }, hasTouch: true });
  try {
    const kiosk = await kioskContext.newPage();
    await kiosk.goto(gymOrigin + '/kiosk');
    await kiosk.getByLabel('Device token', { exact: true }).fill(install.token);
    await kiosk.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
    await kiosk.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect.poll(() => kiosk.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    expect((await kioskContext.cookies()).filter((cookie) => cookie.name.includes('session_token'))).toHaveLength(0);
    await kiosk.getByLabel('Your name', { exact: true }).fill('Jamie River');
    for (const digit of ['1', '3', '5', '7']) await kiosk.getByRole('button', { name: digit, exact: true }).click();
    await kiosk.getByRole('button', { name: 'Find me', exact: true }).click();
    await expect(kiosk.getByRole('checkbox')).toHaveCount(2);
    await expect(kiosk.getByText('Jamie R.', { exact: true })).toBeVisible();
    await expect(kiosk.getByText('Robin R.', { exact: true })).toBeVisible();
    const familyResult = kiosk.waitForResponse((response) => response.url().endsWith('/api/kiosk/checkin'));
    await kiosk.getByRole('button', { name: 'Check in', exact: true }).click();
    const family = await familyResult;
    expect(family.status()).toBe(200);
    const result = await family.text();
    expect(result).not.toMatch(/past.due|amount|medical|example.invalid|billing/i);
    await kiosk.getByRole('listitem').filter({ hasText: 'Jamie R.' }).getByRole('button', { name: /QA evening class/ }).click();
    await expect(kiosk.getByText('Already checked in', { exact: true })).toBeVisible();
    await kiosk.getByRole('listitem').filter({ hasText: 'Robin R.' }).getByRole('button', { name: /QA evening class/ }).click();
    await expect(kiosk.getByText('Checked in', { exact: true })).toBeVisible();
    const axe = await new AxeBuilder({ page: kiosk }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await info.attach('kiosk-accessibility', { body: JSON.stringify(axe.violations, null, 2), contentType: 'application/json' });
    expect(axe.violations).toEqual([]);
    await kiosk.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(kiosk.getByLabel('Your name', { exact: true })).toHaveValue('');
    await expect(kiosk.getByLabel('Household PIN', { exact: true })).toHaveValue('');
    await expect(kiosk.getByRole('link', { name: 'Source code', exact: true })).toBeVisible();
    expect(await kiosk.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await kioskContext.close(); }
  const attendance = await coach.json<{ data: { memberId: string; source: string; sessionId: string }[] }>('/api/attendance?sessionId=' + session.id);
  expect(attendance.data.filter((entry) => entry.memberId === jamie.id)).toHaveLength(1);
  expect(attendance.data.find((entry) => entry.memberId === robin.id)?.source).toBe('kiosk');
  const eligibility = await coach.json<{ data: { memberId: string; eligible: boolean; criteria: { current: number }[] }[] }>(`/api/promotions/eligibility?programId=${install.program.id}&rankId=${rank.id}`);
  expect(eligibility.data.find((entry) => entry.memberId === jamie.id)).toMatchObject({ eligible: true, criteria: [{ current: 2 }] });

  await page.goto(gymOrigin + '/admin/members/' + jamie.id);
  await page.getByRole('tab', { name: 'Ranks & promotions', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Ranks & promotions', exact: true });
  await panel.getByLabel('Program').selectOption(install.program.id);
  await panel.getByLabel('Target rank').selectOption(rank.id);
  await panel.getByLabel('Promotion date and time', { exact: true }).fill(new Date().toISOString().slice(0, 16));
  await panel.getByRole('button', { name: 'Record promotion', exact: true }).click();
  await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Ranks & promotions', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Ranks & promotions', exact: true }).getByRole('listitem').filter({ hasText: rank.name })).toHaveCount(1);
});
