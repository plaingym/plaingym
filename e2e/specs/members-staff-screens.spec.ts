// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';

for (const width of [360, 1280]) {
  test(`member search, profile tabs and staff person links at ${width}px`, async ({ page, context, install }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const owner = install.clients.owner;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Search profile ' + width })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Quinn', lastName: 'Lookup' + width })).data;
    await owner.browser(context);
    await page.goto(gymOrigin + '/admin/members');
    await page.getByLabel('Search members', { exact: true }).fill('Quinn Lookup' + width);
    const link = page.getByRole('link', { name: 'Quinn Lookup' + width });
    await expect(link).toBeVisible(); await link.click();
    const tabs = page.getByRole('tablist');
    await expect(page.getByRole('tab', { name: 'Profile', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect((await tabs.boundingBox())!.y).toBeLessThan((await page.getByLabel('First name', { exact: true }).boundingBox())!.y);
    const danger = page.getByRole('region', { name: 'Erase or delete member data' });
    await expect(danger.getByRole('button', { name: 'Delete member', exact: true })).toBeAttached();
    expect(await danger.evaluate(element => element.parentElement?.lastElementChild === element)).toBe(true);
    await info.attach('member-profile-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.goto(gymOrigin + '/admin/staff');
    await expect(page.getByRole('heading', { name: 'QA Owner Owner', exact: true })).toBeVisible();
    const grant = page.getByRole('button', { name: 'Grant role', exact: true });
    await expect(grant).toBeDisabled();
    await page.getByLabel('Find an account by name or email').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'QA Owner owner@example.invalid', exact: true }).click();
    await expect(grant).toBeEnabled();
    await info.attach('staff-access-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Add profile', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Display name', { exact: true }).fill('Search Coach ' + width);
    await dialog.getByLabel('Find a member to link (optional)').fill('Lookup' + width + ' Quinn');
    await dialog.getByRole('button', { name: 'Quinn Lookup' + width, exact: true }).click();
    await dialog.getByLabel('Find an account by name or email').fill('owner@example.invalid');
    await dialog.getByRole('button', { name: 'QA Owner owner@example.invalid', exact: true }).click();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await info.attach('staff-profile-links-' + width, { body: await dialog.screenshot(), contentType: 'image/png' });
    // Keep the owner without a presentation profile so the next viewport still exercises the fallback name.
    await dialog.getByRole('button', { name: 'Clear selection', exact: true }).last().click();
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await owner.json<{ data: { memberId: string | null; userId: string | null }[] }>('/api/staff/profiles?search=' + encodeURIComponent('Search Coach ' + width))).data;
    expect(saved).toHaveLength(1); expect(saved[0]?.memberId).toBe(member.id); expect(saved[0]?.userId).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
