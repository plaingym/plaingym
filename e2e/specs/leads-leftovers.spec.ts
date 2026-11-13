// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) test(`lead actions and Unicode limits at ${width}px`, async ({ install, page }, info) => {
  const owner = install.clients.owner, firstName = 'Followup' + width, name = firstName + ' Regression';
  const home = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name })).data;
  const member = (await owner.json<{ data: { id: string } }>('/api/members', 'POST', {
    householdId: home.id, firstName, lastName: 'Regression', status: 'prospect',
  })).data;
  await owner.json('/api/leads/' + member.id, 'PATCH', { revision: 0, source: 'referral', nextFollowUpOn: '2026-01-01' });
  await owner.browser(page.context()); await page.setViewportSize({ width, height: 900 });
  const capture = async (label: string) => {
    await accessibleLayout(page, info, label + '-' + width);
    await info.attach(label + '-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  };
  await page.goto(gymOrigin + '/admin/leads');
  await page.getByRole('link', { name, exact: true }).waitFor();
  await page.getByLabel('Source', { exact: true }).selectOption('referral');
  await page.getByLabel('Stage for ' + name, { exact: true }).selectOption('contacted');
  await expect(page.getByRole('status').filter({ hasText: 'Lead saved.' })).toBeVisible();
  await expect(page.locator(':focus')).toHaveText('Lead saved.');
  await capture('leads-board');
  await page.getByRole('button', { name: 'Mark lost: ' + name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason', { exact: true }).fill('\u{1F600}'.repeat(501));
  await dialog.getByRole('button', { name: 'Mark lost', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a reason of at most 500 characters.');
  await capture('leads-reason-error');
  await dialog.getByLabel('Reason', { exact: true }).fill('\u{1F600}'.repeat(500));
  await dialog.getByRole('button', { name: 'Mark lost', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto(gymOrigin + '/admin/leads/' + member.id);
  await page.getByRole('heading', { name, exact: true }).waitFor();
  const note = page.getByLabel('Note (optional)', { exact: true });
  await note.fill('\u{1F600}'.repeat(2001));
  await page.getByRole('button', { name: 'Log contact', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a note of at most 2,000 characters.');
  await capture('lead-contact-error');
  await note.fill('\u{1F600}'.repeat(2000));
  await page.getByRole('button', { name: 'Log contact', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Contact logged.' })).toBeVisible();
  await capture('lead-contact-saved');
  await page.getByRole('button', { name: 'Reopen lead: ' + name, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Lead reopened as contacted.' })).toBeVisible();
  await page.goto(gymOrigin + '/admin');
  await expect(page.getByRole('heading', { name: 'Follow-ups due', exact: true })).toBeVisible();
  await capture('leads-dashboard');
});
