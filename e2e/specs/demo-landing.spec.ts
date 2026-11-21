// SPDX-License-Identifier: AGPL-3.0-only
import type { Locator, Page } from '@playwright/test';
import { Client, test, expect } from '../support.js';
import { accessibleLayout, horizontalOverflow, tabTo } from '../responsive.js';

const themes = ['light', 'dark'] as const;
type Theme = typeof themes[number];
const entryOrigin = 'https://demo.localhost';
const showcaseLink = /^https:\/\/showcase\.demo\.localhost\/demo#kioskToken=.+$/;
const menuScriptPath = /^\/demo-assets\/landing-menu-[a-f0-9]{16}\.js$/;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const client = new Client(entryOrigin);
  await expect.poll(async () => {
    const { status, body } = await client.request<{ data?: { showcase?: string } }>('/api/demo');
    return status === 200 && showcaseLink.test(body?.data?.showcase ?? '');
  }, { timeout: 150_000, intervals: [2_000], message: 'The showcase is ready with a kiosk token' }).toBe(true);
});

async function open(page: Page, width: number, colorScheme: Theme, height = 900) {
  // An implicit icon request is unrelated to this page's stylesheet and CSP.
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.setViewportSize({ width, height });
  // Reduced motion turns the page's colour transitions off, so a state is measured as it settles.
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  const response = await page.goto(entryOrigin + '/');
  expect(response?.status()).toBe(200);
  return response!;
}

const header = (page: Page) => page.locator('body > header');
const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Text against the colours behind it, and the keyboard ring against its surroundings, from computed styles. */
function contrast(element: Element) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })!;
  // The canvas resolves any CSS colour (oklch, color-mix, keywords) to sRGB.
  const rgba = (color: string) => {
    canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = '#000'; canvas.fillStyle = color; canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, a! / 255] as const;
  };
  const over = (top: readonly number[], bottom: readonly number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
  const behind = (start: Element | null) => {
    const layers: (readonly number[])[] = [];
    for (let node = start; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.unshift(color);
      if (color[3] >= 1) break;
    }
    return layers.reduce((base, layer) => over(layer, base), matchMedia('(prefers-color-scheme: dark)').matches ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  };
  const luminance = (color: readonly number[]) => [0, 1, 2].map(i => { const v = color[i]! / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: readonly number[], b: readonly number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  const style = getComputedStyle(element), background = behind(element);
  const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    ? ratio(over(rgba(style.outlineColor), behind(element.parentElement)), behind(element.parentElement)) : 0;
  return { name: (element.textContent || element.getAttribute('aria-label') || '').trim(), text: ratio(over(rgba(style.color), background), background), ring,
    transition: style.transitionProperty === 'none' ? '0s' : style.transitionDuration };
}

for (const width of [360, 768, 1280]) for (const colorScheme of themes) {
  test(`demo product landing at ${width}px in ${colorScheme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Registered before navigation, including the stylesheet load.
    await page.addInitScript(() => {
      (window as Window & { policyViolations?: string[] }).policyViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        (window as Window & { policyViolations?: string[] }).policyViolations!.push(event.violatedDirective);
      });
    });
    const stylesLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/public/pages/styles.css');
    const pageStyles = page.waitForResponse(response => /^\/demo-assets\/landing-[a-f0-9]{16}\.css$/.test(new URL(response.url()).pathname));
    const response = await open(page, width, colorScheme);
    expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers()['content-security-policy']).toContain("style-src 'self'");
    await expect(page.getByRole('heading', { level: 1, name: 'PlainGym', exact: true })).toBeVisible();
    const links = page.getByRole('main').getByRole('link');
    await expect(links.nth(0)).toHaveText('Try the demo');
    await expect(links.nth(0)).toHaveAttribute('href', showcaseLink);
    await expect(links.nth(1)).toHaveText('GitHub');
    await expect(links.nth(1)).toHaveAttribute('href', 'https://github.com/plaingym/plaingym');
    await expect(page.getByRole('link', { name: 'Source code', exact: true })).toHaveAttribute('href', '/source');
    await expect(page.locator('script')).toHaveAttribute('src', menuScriptPath);
    await expect(page.locator('script:not([src]), [style]')).toHaveCount(0);
    // Explain the general lifetime without showing a particular sandbox's expiry notice.
    await expect(page.getByText('Private copies expire after inactivity and are deleted within 24 hours.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-demo-deletion]')).toHaveCount(0);
    for (const stylesheet of [await stylesLoaded, await pageStyles]) {
      expect(stylesheet.status()).toBe(200);
      expect(stylesheet.headers()['content-type']).toContain('text/css');
    }
    expect((await pageStyles).headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    await accessibleLayout(page, info, `product-${width}-${colorScheme}`);
    expect(await page.evaluate(() => (window as Window & { policyViolations?: string[] }).policyViolations)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`product-${width}-${colorScheme}.png`), fullPage: true });

    // The header stays at the top of the screen halfway down the page.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    await expect.poll(async () => (await box(header(page))).y).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

    // On phones the menu opens just below the header wherever the page is scrolled, and stays there.
    const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
    const menu = page.locator('#site-menu');
    const row = header(page).getByRole('navigation', { name: 'Main' });
    if (width < 768) {
      await expect(row).toBeHidden();
      const scrolled = await page.evaluate(() => window.scrollY);
      // Tap where the button is on screen: Playwright's own click scrolls the page to a control in a sticky header first.
      const tap = await box(menuButton);
      await page.mouse.click(tap.x + tap.width / 2, tap.y + tap.height / 2);
      await expect(menu).toBeVisible();
      const [bar, panel] = [await box(header(page)), await box(menu)];
      expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height);
      expect(panel.y - (bar.y + bar.height)).toBeLessThan(16);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
      await page.screenshot({ path: info.outputPath(`product-${width}-${colorScheme}-menu.png`) });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    } else {
      await expect(menuButton).toBeHidden();
      await expect(header(page).locator('.demo-menu-fallback')).toBeHidden();
      await expect(row).toBeVisible();
      const bounds = await box(row);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await horizontalOverflow(page)).toBeUndefined();
    }

    // Exercise the native section links on phones even when the menu script is unavailable.
    if (width < 768) {
      await page.route('**/demo-assets/landing-menu-*.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }), { times: 1 });
      await page.reload();
    }

    // Each header link brings its section's heading fully into view below the header.
    for (const [name, id] of [['Why PlainGym', 'strengths'], ['Features', 'features'], ['How the demo works', 'explore']] as const) {
      await page.evaluate(() => window.scrollTo(0, 0));
      if (width < 768) { await menuButton.click(); await menu.getByRole('link', { name, exact: true }).click(); }
      else await row.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      const heading = page.locator('#' + id);
      // Without script a followed link leaves the phone menu open, so the heading must clear the panel as well.
      const covers = width < 768 ? [header(page), menu] : [header(page)];
      await expect.poll(async () => {
        const target = await box(heading);
        let bottom = 0;
        for (const cover of covers) { const area = await box(cover); bottom = Math.max(bottom, area.y + area.height); }
        return target.y >= bottom && target.y + target.height <= (page.viewportSize()?.height ?? 0);
      }, `${id} heading below the header`).toBe(true);
      // Escape (or a tap outside) closes the menu.
      if (width < 768) { await expect(menu).toBeVisible(); await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); }
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await links.first().click();
    await expect(page).toHaveURL('https://showcase.demo.localhost/demo');
    await expect(page.getByRole('heading', { level: 1, name: 'Your demo gym', exact: true })).toBeVisible();
    await expect(page.locator('[data-demo-deletion]')).toHaveCount(0);
  });

  test(`demo product controls stay readable on hover and focus at ${width}px in ${colorScheme}`, async ({ page }) => {
    await open(page, width, colorScheme);
    const controls = page.locator('body > header :is(a, button, summary):visible, main > header a, body > footer a');
    const count = await controls.count();
    expect(count).toBeGreaterThanOrEqual(width < 768 ? 8 : 11);
    const failures: string[] = [];
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      await control.scrollIntoViewIfNeeded();
      await control.hover();
      const hovered = await control.evaluate(contrast);
      if (hovered.text < 4.5) failures.push(`hover "${hovered.name}" ${hovered.text.toFixed(2)}`);
      if (hovered.transition.split(',').some(value => parseFloat(value) > 0)) failures.push(`transition "${hovered.name}" ${hovered.transition}`);
      await page.mouse.move(0, 0);
    }
    // Keyboard focus from the top of the page, in tab order: a visible ring (3:1) and readable text (4.5:1).
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      await tabTo(page, control);
      const focused = await control.evaluate(contrast);
      if (focused.text < 4.5) failures.push(`focus "${focused.name}" ${focused.text.toFixed(2)}`);
      if (focused.ring < 3) failures.push(`focus ring "${focused.name}" ${focused.ring.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });
}

test.describe('demo product phone menu', () => {
  test.use({ hasTouch: true });

  test('stays below the header with a wrapped label, and dismisses with Escape and an outside tap at 360px', async ({ page }, info) => {
    await open(page, 360, 'light', 900);
    const menuButton = header(page).getByRole('button', { name: 'Menu', exact: true });
    const menu = header(page).locator('#site-menu');
    await menuButton.tap();
    for (const name of ['Why PlainGym', 'Features', 'How the demo works', 'Try the demo', 'GitHub']) {
      const item = menu.getByRole('link', { name, exact: true });
      expect((await box(item)).height, name).toBeLessThan(55);
      expect(await item.evaluate(node => node.scrollWidth <= node.clientWidth), name).toBe(true);
    }

    await open(page, 360, 'light', 440);
    await expect(header(page).getByRole('navigation', { name: 'Main' })).toBeHidden();
    await expect(header(page).locator('.demo-menu-fallback')).toBeHidden();
    expect(await horizontalOverflow(page)).toBeUndefined();
    await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
    const wrapped = menu.locator('a[href="#strengths"]');
    await wrapped.evaluate(link => { link.textContent = 'Why you can run your gym on your own terms with PlainGym'; });
    await menuButton.tap();
    await expect(menu).toBeVisible();
    const panel = await box(menu);
    expect(panel.y).toBeGreaterThanOrEqual((await box(header(page))).height);
    expect(panel.x + panel.width).toBeLessThanOrEqual(360);
    const item = menu.getByRole('link', { name: 'Why you can run your gym on your own terms with PlainGym' });
    expect((await box(item)).height).toBeGreaterThan(55);
    expect(await menu.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(menu).toHaveCSS('overflow-y', 'auto');
    await expect(menu).toHaveCSS('overscroll-behavior-y', 'contain');
    await page.screenshot({ path: info.outputPath('product-360-wrapped-menu.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await menuButton.tap();
    await expect(menu).toBeVisible();
    await page.touchscreen.tap(10, 425);
    await expect(menu).toBeHidden();
  });

  test('closes the phone menu after a section link and lets it reopen at 360px', async ({ page }) => {
    await open(page, 360, 'light');
    const menuButton = header(page).getByRole('button', { name: 'Menu', exact: true });
    const menu = header(page).locator('#site-menu');
    for (const [name, id] of [['Features', 'features'], ['Why PlainGym', 'strengths']] as const) {
      await menuButton.tap();
      await expect(menu.getByRole('link')).toHaveCount(5);
      await menu.getByRole('link', { name, exact: true }).tap();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator('#' + id)).toBeInViewport();
      await expect(page.locator('#site-menu:popover-open')).toHaveCount(0);
    }
  });
});

// T1029: on a phone held upright, an opened screenshot is shown large enough to read and scrolls inside the lightbox.
for (const width of [360, 390]) for (const colorScheme of themes) {
  test(`demo product lightbox enlarges screenshots at ${width}px portrait in ${colorScheme}`, async ({ page }, info) => {
    await open(page, width, colorScheme, 780);
    const zoom = page.getByRole('button', { name: 'Enlarge screenshot: Members and households', exact: true });
    await zoom.scrollIntoViewIfNeeded();
    const inline = (await box(zoom.locator('img'))).width;
    await zoom.click();
    const lightbox = page.locator('#shot-members');
    await expect(lightbox).toBeVisible();
    const image = lightbox.locator('img');
    await expect(image).toHaveJSProperty('complete', true);
    expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await box(image)).width).toBeGreaterThanOrEqual(inline * 2);
    await page.screenshot({ path: info.outputPath(`lightbox-${width}-${colorScheme}.png`) });
    // Scroll the lightbox to its far corner: the image's edge comes into view, the close button stays put and uncovered.
    const edge = await lightbox.evaluate(node => {
      node.scrollTo(node.scrollWidth, node.scrollHeight);
      return { left: node.scrollLeft, maxLeft: node.scrollWidth - node.clientWidth, top: node.scrollTop, maxTop: node.scrollHeight - node.clientHeight };
    });
    expect(edge.maxLeft).toBeGreaterThan(0);
    expect(edge.left).toBeGreaterThanOrEqual(edge.maxLeft - 1);
    expect(edge.top).toBeGreaterThanOrEqual(edge.maxTop - 1);
    const picture = await box(image);
    expect(picture.x + picture.width).toBeLessThanOrEqual(width);
    const close = lightbox.getByRole('button', { name: 'Close screenshot', exact: true });
    const button = await box(close);
    expect(button.x).toBeGreaterThanOrEqual(0); expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(width); expect(button.height).toBeGreaterThanOrEqual(44);
    expect(await close.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    await page.screenshot({ path: info.outputPath(`lightbox-${width}-${colorScheme}-far.png`) });
    // The page behind never scrolls sideways.
    expect(await horizontalOverflow(page)).toBeUndefined();
    expect(await page.evaluate(() => [window.scrollX, document.documentElement.scrollWidth <= window.innerWidth])).toEqual([0, true]);
    await close.click();
    await expect(lightbox).toBeHidden();
  });
}

test('old demo entry links redirect to the product page', async ({ page }) => {
  await page.goto('https://demo.localhost/demo');
  await expect(page).toHaveURL('https://demo.localhost/');
  await expect(page.getByRole('heading', { level: 1, name: 'PlainGym', exact: true })).toBeVisible();
});
