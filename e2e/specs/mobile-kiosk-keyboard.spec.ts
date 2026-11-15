// SPDX-License-Identifier: AGPL-3.0-only
import { expect, demoClient, test, type Person, type RecordId } from '../support.js';
import { accessibleThemes, keyboardActivate, tabTo } from '../responsive.js';
import { viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

for (const { name: size, viewport } of viewports) {
  test(`kiosk check-in by keyboard alone at ${size} width`, async ({ page, sandboxes }, info) => {
    const sandbox = sandboxes[0]!;
    const owner = await demoClient(sandbox, 'owner');
    const memberRow = (await owner.json<{ data: Person[] }>('/api/members?search=Marcus')).data.find(person => person.firstName === 'Marcus' && person.lastName === 'Rivera')!;
    const current = (await owner.json<{ data: RecordId }>('/api/households/' + memberRow.householdId)).data;
    // The isolation sweep deliberately changes this household's PIN. Own this flow's credentials.
    await owner.json('/api/households/' + memberRow.householdId + '/pin', 'PUT', { revision: current.revision, pin: '2468' });
    await page.setViewportSize(viewport);
    await page.goto(sandbox.origin + '/kiosk');
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await tabTo(page, skip);
    const skipBox = (await skip.boundingBox())!;
    expect(skipBox.height).toBeGreaterThanOrEqual(44);
    expect(skipBox.width).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByLabel('Device token', { exact: true }));
    await page.keyboard.insertText(sandbox.kioskToken);
    await keyboardActivate(page, page.getByRole('button', { name: 'Save and start check-in', exact: true }));
    await expect(page.getByRole('heading', { name: 'How would you like to check in?', exact: true })).toBeFocused();
    await accessibleThemes(page, info, size + '-keyboard-kiosk-choice');
    await keyboardActivate(page, page.getByRole('button', { name: 'Scan a QR code', exact: true }));
    await expect(page.locator('[data-kiosk-focus]')).toBeFocused();
    await accessibleThemes(page, info, size + '-keyboard-kiosk-camera');
    await keyboardActivate(page, page.getByRole('button', { name: 'Start over', exact: true }));
    await keyboardActivate(page, page.getByRole('button', { name: 'Name and PIN', exact: true }));
    await expect(page.getByLabel('Your name', { exact: true })).toBeFocused();
    await page.keyboard.insertText('Marcus Rivera');
    await tabTo(page, page.getByLabel('Household PIN', { exact: true }));
    await page.keyboard.insertText('2468');
    await accessibleThemes(page, info, size + '-keyboard-kiosk-search');
    await keyboardActivate(page, page.getByRole('button', { name: 'Find me', exact: true }));
    await expect(page.locator('#kiosk-select')).toBeFocused();
    const member = page.getByRole('checkbox', { name: /Marcus/ });
    await tabTo(page, member);
    await page.keyboard.press('Space');
    await expect(member).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Space');
    await expect(member).toHaveAttribute('aria-checked', 'true');
    await accessibleThemes(page, info, size + '-keyboard-kiosk-members');
    await keyboardActivate(page, page.getByRole('button', { name: 'Check in', exact: true }));
    await expect(page.getByRole('heading', { name: 'Check-in results', exact: true })).toBeFocused();
    // A first visit offers open mat; a later viewport can already be checked in.
    const openMat = page.getByRole('button', { name: 'Open mat', exact: true });
    const choices = await openMat.count();
    for (let i = 0; i < choices; i++) await keyboardActivate(page, openMat.first());
    await expect(openMat).toHaveCount(0);
    await expect(page.getByText(/^(Checked in|Already checked in)$/).first()).toBeVisible();
    await accessibleThemes(page, info, size + '-keyboard-kiosk-results');
    await keyboardActivate(page, page.getByRole('button', { name: 'Done', exact: true }));
    await expect(page.locator('#kiosk-choose')).toBeFocused();
  });
}
