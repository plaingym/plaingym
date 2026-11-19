// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client, demoClient, type RecordId } from '../support.js';
import { claimPortal, outboxIds, outboxLink } from '../portal.js';
import { check } from './mobile-screens.js';

// Invitation and sign-in links are bearer credentials; retain screenshots only after sign-in.
test.use({ trace: 'off', screenshot: 'off' });
for (const width of [360, 1280]) test('SMS choices on staff, portal and join screens at ' + width + 'px', async ({ sandboxes, page, context }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width, height: 800 });
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), email = `sms-${crypto.randomUUID()}@example.test`;
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'SMS household ' + width, email, phone: '+12025550123' })).data;
  const member = (await owner.json<{ data: RecordId }>('/api/members', 'POST', { householdId: home.id, firstName: 'SMS', lastName: 'Child ' + width,
    phone: '+12025550123', dateOfBirth: '2016-06-01', status: 'active' })).data;
  await owner.browser(context);
  await page.goto(sandbox.origin + '/admin/members/' + member.id);
  await expect(page.getByRole('button', { name: 'Record verbal notices consent' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Record verbal notices consent' }).first().click();
  await expect(page.getByRole('button', { name: 'Withdraw notices consent' }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Text message consent' })).toHaveCount(2);
  await expect(page.getByText('Only the member or a payer managing their profile can give announcements consent.')).toBeVisible();
  await check(page, info, 'sms-staff-' + width);

  const invitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST', { email, delivery: 'print', scope: 'payer' });
  const before = await outboxIds(owner);
  await new Client(sandbox.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.data.invitationUrl).hash.slice(1) });
  const payer = await claimPortal(sandbox.origin, await outboxLink(owner, email, /^\/api\/auth\//, before));
  await payer.browser(context); await page.goto(sandbox.origin + '/portal/household');
  const householdName = page.getByRole('textbox', { name: 'Household name', exact: true });
  const draftName = 'SMS household draft ' + width;
  await householdName.fill(draftName);
  await expect(page.getByRole('button', { name: 'Agree to announcements' })).toBeVisible();
  await page.getByRole('button', { name: 'Agree to announcements' }).click();
  await expect(page.getByRole('button', { name: 'Withdraw announcements consent' })).toBeVisible();
  await expect(householdName).toHaveValue(draftName);
  await page.getByRole('button', { name: 'Agree to notices', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agree to notices', exact: true })).toHaveCount(0);
  await expect(householdName).toHaveValue(draftName);
  await check(page, info, 'sms-portal-payer-' + width);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(householdName).toHaveValue(draftName);
  await page.reload();
  await expect(householdName).toHaveValue(draftName);
  await page.getByRole('button', { name: 'Withdraw announcements consent' }).click();
  await expect(page.getByRole('button', { name: 'Agree to announcements' })).toBeVisible();

  const adultEmail = `sms-adult-${crypto.randomUUID()}@example.test`;
  const adult = (await owner.json<{ data: RecordId }>('/api/members', 'POST', { householdId: home.id, firstName: 'SMS', lastName: 'Adult ' + width,
    email: adultEmail, phone: '+12025550199', dateOfBirth: '1990-01-01', status: 'active' })).data;
  const adultInvitation = await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST', { email: adultEmail, delivery: 'print', scope: 'member', memberId: adult.id });
  const adultBefore = await outboxIds(owner);
  await new Client(sandbox.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(adultInvitation.data.invitationUrl).hash.slice(1) });
  const adultLogin = await claimPortal(sandbox.origin, await outboxLink(owner, adultEmail, /^\/api\/auth\//, adultBefore));
  await context.clearCookies(); await adultLogin.browser(context); await page.goto(sandbox.origin + '/portal/household');
  for (const kind of ['notices', 'announcements']) {
    await page.getByRole('button', { name: 'Agree to ' + kind, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Withdraw ' + kind + ' consent' })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Text message consent' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit details', exact: true })).toHaveCount(0);
  await check(page, info, 'sms-portal-adult-' + width);
  for (const kind of ['notices', 'announcements']) {
    await page.getByRole('button', { name: 'Withdraw ' + kind + ' consent' }).click();
    await expect(page.getByRole('button', { name: 'Agree to ' + kind, exact: true })).toBeVisible();
  }

  await context.clearCookies(); await page.goto(sandbox.origin + '/join');
  await page.getByRole('link', { name: /^Choose / }).first().click();
  await expect(page.locator('input[name=smsNoticesConsent]')).not.toBeChecked();
  await expect(page.locator('input[name=smsAnnouncementsConsent]')).not.toBeChecked();
  await expect(page.getByText('To agree to texts, enter a valid contact phone number, including its country code if needed.', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await info.attach('sms-join-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});
