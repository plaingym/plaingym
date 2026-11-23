// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, createClass, demoClient, gymTimezone, showWeek, type Sandbox } from '../support.js';
import { sizes } from '../responsive.js';

// Cookies are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });

/** The dialog never scrolls itself, and once the body holds more than fits, only the body scrolls. */
async function onlyBodyScrolls(page: Page, dialog: Locator, surface: string) {
  // Pad the last child of the scrolling body so the content always overflows, whatever the seed data holds.
  await dialog.evaluate((element) => {
    const body = element.querySelector('[data-dialog-body]')!;
    const filler = document.createElement('div');
    filler.setAttribute('data-filler', '');
    filler.style.height = '3000px';
    body.append(filler);
  });
  const measure = await dialog.evaluate((element) => {
    const body = element.querySelector('[data-filler]')!.parentElement!;
    const heading = element.querySelector('h2')!.getBoundingClientRect();
    return { dialog: { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop },
      body: { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
      headingTop: heading.top, dialogTop: element.getBoundingClientRect().top,
      lowest: [...element.querySelectorAll('*')].filter(e => !body.contains(e) && e !== body)
        .map(e => ({ n: e.tagName + '.' + String(e.className).slice(0, 60), b: Math.round(e.getBoundingClientRect().bottom) })).sort((a, b) => b.b - a.b).slice(0, 3),
      dialogBottom: Math.round(element.getBoundingClientRect().bottom), bodyBottom: Math.round(body.getBoundingClientRect().bottom) };
  });
  expect(measure.dialog.scrollHeight, surface + ': the dialog element does not scroll ' + JSON.stringify(measure)).toBeLessThanOrEqual(measure.dialog.clientHeight);
  expect(measure.body.scrollHeight, surface + ': the body scrolls').toBeGreaterThan(measure.body.clientHeight);
  // Scrolling the body leaves the header where it was.
  await dialog.evaluate((element) => { element.querySelector('[data-filler]')!.parentElement!.scrollTop = 500; });
  const after = await dialog.evaluate((element) => ({ scrollTop: element.scrollTop, headingTop: element.querySelector('h2')!.getBoundingClientRect().top }));
  expect(after.scrollTop, surface + ': the dialog stays at the top').toBe(0);
  expect(after.headingTop, surface + ': the header stays put').toBe(measure.headingTop);
  const box = (await dialog.boundingBox())!;
  expect(box.height, surface + ': the dialog fits the viewport').toBeLessThanOrEqual(page.viewportSize()!.height);
}

for (const size of sizes) {
  test(`long dialogs scroll only their body at ${size.width}x${size.height}`, async ({ page, sandboxes }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    const sandbox: Sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
    const name = 'Scroll ' + randomBytes(3).toString('hex'), session = await createClass(owner, name);
    const zone = await gymTimezone(owner);
    await owner.browser(page.context());

    await page.goto(sandbox.origin + '/admin/schedule');
    await showWeek(page, zone, Date.parse(session.startsAt));
    await page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
    const sessionDialog = page.getByRole('dialog', { name });
    await expect(sessionDialog).toBeVisible();
    await onlyBodyScrolls(page, sessionDialog, 'session dialog');
    await page.keyboard.press('Escape');
    await expect(sessionDialog).toBeHidden();

    await page.goto(sandbox.origin + '/admin/campaigns');
    await page.getByRole('button', { name: 'New campaign', exact: true }).click();
    const campaignDialog = page.getByRole('dialog', { name: 'New campaign' });
    await expect(campaignDialog).toBeVisible();
    await onlyBodyScrolls(page, campaignDialog, 'campaign editor');
  });
}

const actionSizes = sizes.filter(({ width }) => width === 360 || width === 1280);

async function openWeeklyClass(page: Page, sandbox: Sandbox) {
  const owner = await demoClient(sandbox, 'owner');
  await owner.browser(page.context());
  await page.goto(sandbox.origin + '/admin/schedule');
  // The empty week can also offer this action below the page header.
  await page.getByRole('button', { name: 'New weekly class', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New weekly class' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Add test-only height above the actions, so the long form overflows and the bar still follows its end. */
async function padAboveActions(dialog: Locator) {
  await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('[data-dialog-body]')!;
    const actions = element.querySelector<HTMLElement>('[data-dialog-actions]')!;
    body.scrollTop = 0;
    const filler = document.createElement('div');
    filler.setAttribute('data-actions-filler', '');
    filler.style.height = '1600px';
    actions.parentElement!.insertBefore(filler, actions);
  });
}

/** Scroll the body to the middle of its range and measure the sticky bar against its bottom edge. */
async function middleOfLongForm(dialog: Locator) {
  await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('[data-dialog-body]')!;
    body.scrollTop = (body.scrollHeight - body.clientHeight) / 2;
  });
  return dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('[data-dialog-body]')!;
    const actions = element.querySelector<HTMLElement>('[data-dialog-actions]')!;
    const bodyRect = body.getBoundingClientRect(), actionsRect = actions.getBoundingClientRect();
    return { scrollTop: body.scrollTop, scrollRange: body.scrollHeight - body.clientHeight,
      actionsGap: Math.abs(bodyRect.bottom - actionsRect.bottom), bodyTop: bodyRect.top, bodyBottom: bodyRect.bottom,
      buttons: [...actions.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { name: button.textContent?.trim(), top: rect.top, bottom: rect.bottom };
      }) };
  });
}

for (const size of actionSizes) {
  test(`weekly class actions cover the body edge at ${size.width}x${size.height}`, async ({ page, sandboxes }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    const dialog = await openWeeklyClass(page, sandboxes[1]!);
    await padAboveActions(dialog);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const measured = await middleOfLongForm(dialog);
      expect(measured.scrollRange, colorScheme + ': the form is longer than the body').toBeGreaterThan(0);
      expect(measured.scrollTop, colorScheme + ': the body is halfway down').toBeGreaterThan(0);
      expect(measured.scrollTop, colorScheme + ': the body is halfway down').toBeLessThan(measured.scrollRange);
      expect(measured.actionsGap, colorScheme + ': the action background reaches the body edge').toBeLessThanOrEqual(1);
      for (const button of measured.buttons) {
        expect(button.top, colorScheme + ': ' + button.name + ' starts inside the body').toBeGreaterThanOrEqual(measured.bodyTop - 1);
        expect(button.bottom, colorScheme + ': ' + button.name + ' ends inside the body').toBeLessThanOrEqual(measured.bodyBottom + 1);
      }
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    }
  });
}

test('short weekly class keeps its action row spacing at 1280x1200', async ({ page, sandboxes }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1200 });
  const dialog = await openWeeklyClass(page, sandboxes[1]!);
  const measured = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('[data-dialog-body]')!;
    const actions = element.querySelector<HTMLElement>('[data-dialog-actions]')!;
    const help = [...body.querySelectorAll('p')].find(paragraph => paragraph.textContent?.includes('Times use the gym timezone'));
    if (!help) throw new Error('The timezone help is missing');
    const bodyRect = body.getBoundingClientRect(), actionsRect = actions.getBoundingClientRect();
    const buttons = [...actions.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return { bodyOverflow: body.scrollHeight > body.clientHeight, dialogOverflow: element.scrollHeight > element.clientHeight,
      helpGap: actionsRect.top - help.getBoundingClientRect().bottom,
      buttonGap: bodyRect.bottom - Math.max(...buttons.map(rect => rect.bottom)) };
  });
  expect(measured.dialogOverflow, 'the dialog does not scroll').toBe(false);
  expect(measured.bodyOverflow, 'the short form fits its body').toBe(false);
  expect(measured.helpGap, 'the timezone help to the action row').toBeCloseTo(16, 0);
  expect(measured.buttonGap, 'the lowest action button to the body edge').toBeCloseTo(36, 0);
});

test.describe('page scroll behind a weekly class dialog', () => {
  test.use({ hasTouch: true });

  for (const size of actionSizes) {
    test(`stays locked under wheel and touch input at ${size.width}x${size.height}`, async ({ page, sandboxes }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
      await owner.browser(page.context());
      await page.goto(sandbox.origin + '/admin/schedule');
      const opener = page.getByRole('button', { name: 'New weekly class', exact: true }).first();
      await expect(opener).toBeVisible();
      const scrollY = () => page.evaluate(() => window.scrollY);
      await page.evaluate(() => {
        document.body.style.minHeight = '2000px';
        window.scrollTo(0, 300);
      });
      expect(await scrollY()).toBe(300);
      // Activate the opener at this scroll position without Playwright scrolling it into view.
      await opener.evaluate(button => (button as HTMLButtonElement).click());
      const dialog = page.getByRole('dialog', { name: 'New weekly class' });
      await expect(dialog).toBeVisible();
      const dialogBox = (await dialog.boundingBox())!;
      if (size.width === 360) expect(dialogBox.width).toBe(size.width);
      else expect(dialogBox.x + dialogBox.width / 2).toBeCloseTo(size.width / 2, 0);
      await padAboveActions(dialog);
      const body = dialog.locator('[data-dialog-body]');
      const bodyBox = (await body.boundingBox())!;
      const titleBox = (await dialog.getByRole('heading', { name: 'New weekly class' }).boundingBox())!;
      const bodyPoint = { x: bodyBox.x + 8, y: bodyBox.y + 250 };
      const headerPoint = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
      const remaining = () => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop));
      const expectLocked = async (input: string) => {
        // Wheel input can be applied asynchronously by the browser.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await scrollY(), input).toBe(300);
      };

      await page.mouse.move(bodyPoint.x, bodyPoint.y);
      await expect.poll(async () => {
        await page.mouse.wheel(0, 600);
        return remaining();
      }).toBeLessThanOrEqual(1);
      await expectLocked('wheel to the body end');
      await page.mouse.wheel(0, 600);
      await expectLocked('wheel past the body end');
      await page.mouse.move(headerPoint.x, headerPoint.y);
      await page.mouse.wheel(0, 600);
      await expectLocked('wheel over the header');
      if (size.width === 1280) {
        await page.mouse.move(10, size.height / 2);
        await page.mouse.wheel(0, 600);
        await expectLocked('wheel over the backdrop');
      }

      await body.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 100; });
      const cdp = await page.context().newCDPSession(page);
      const swipe = async ({ x, y }: { x: number; y: number }, distance: number) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * fraction }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await swipe(bodyPoint, -200);
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      await expectLocked('touch scroll to the body end and beyond');
      await swipe(headerPoint, 200);
      await expectLocked('touch scroll over the header');
      await cdp.detach();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(await scrollY(), 'closing restores the page position').toBe(300);
      await page.mouse.move(size.width / 2, size.height / 2);
      await page.mouse.wheel(0, 600);
      await expect.poll(scrollY).toBeGreaterThan(300);
    });
  }
});
