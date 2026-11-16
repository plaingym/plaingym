// SPDX-License-Identifier: AGPL-3.0-only
// Manual, service-free review of the actual server renderer and committed screenshots. Run with tsx.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { demoLandingPage, demoLandingDirectives, landingStylesheet } from '../../../../server/src/demo/landing.page.js';
import { buildLinkStyles } from '../../../../server/src/public/links/styles.build.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url)), output = resolve(root, 'coverage/demo/product');
const { chromium, firefox, webkit, expect } = await import(new URL('e2e/node_modules/@playwright/test/index.mjs', 'file:///' + root.replaceAll('\\', '/')).href);
await mkdir(output, { recursive: true });
await buildLinkStyles(resolve(output, 'styles.css'));
const html = demoLandingPage('/sandbox', 'https://github.com/plaingym/plaingym');
const css = await readFile(resolve(output, 'styles.css'));
const extra = landingStylesheet.body;
expect(Buffer.byteLength(html) + css.length + extra.length).toBeLessThan(300_000);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Security-Policy', demoLandingDirectives.join('; ')); res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else if (path === '/public/pages/styles.css' || path === '/demo-assets/' + landingStylesheet.file) { res.setHeader('Content-Type', 'text/css'); res.end(path.startsWith('/demo-assets/') ? extra : css); }
    else if (/^\/demo-assets\/[a-z0-9-]+\.webp$/.test(path)) { res.setHeader('Content-Type', 'image/webp'); res.end(await readFile(resolve(root, 'apps/server/src/demo/screenshots', path.split('/').pop()))); }
    else res.writeHead(404).end();
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port, results = [];
const timer = setTimeout(() => { console.error('Product browser check timed out'); process.exit(1); }, 180_000);
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    console.log('Checking ' + name);
    const browser = await engine.launch({ headless: true, timeout: 30_000 });
    try {
      for (const width of [360, 1280]) for (const theme of ['light', 'dark']) {
        // Firefox's automation evaluation can stall with context-wide scripting disabled.
        // The response's script-src 'none' forbids page scripts in every engine; Chromium also disables the context.
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', javaScriptEnabled: name !== 'chromium' });
        const page = await context.newPage(), failures = [], requests = [];
        page.setDefaultTimeout(12_000);
        console.log(`${name} ${width} ${theme}`);
        page.on('console', message => { if (/content.security.policy|refused to/i.test(message.text())) failures.push(message.text()); });
        page.on('request', request => requests.push(request.url()));
        await page.goto(origin);
        console.log('Page loaded');
        expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
        expect(await page.locator('a, button').evaluateAll(nodes => nodes.filter(node => {
          const r = node.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44);
        }).map(node => node.outerHTML))).toEqual([]);
        const triggers = page.locator('button.demo-zoom');
        for (let index = 0; index < await triggers.count(); index++) {
          const trigger = triggers.nth(index), id = await trigger.getAttribute('popovertarget'), popover = page.locator('#' + id);
          await trigger.click();
          await expect(popover).toBeVisible();
          const image = popover.locator('img');
          await expect(image).toHaveJSProperty('complete', true);
          expect(await image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
          const close = popover.getByRole('button', { name: 'Close screenshot' });
          // On a phone held upright the image keeps its own width and scrolls inside the lightbox; the close button stays in view.
          for (const item of width < 768 ? [close] : [image, close]) {
            const b = await item.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(900);
          }
          if (index === 0 && name !== 'webkit') await page.screenshot({ path: resolve(output, `${name}-${width}-${theme}-lightbox.png`), caret: 'initial' });
          await page.keyboard.press('Escape'); await expect(popover).toBeHidden(); await expect(trigger).toBeFocused();
          await trigger.click(); await page.mouse.click(1, 1); await expect(popover).toBeHidden();
          await trigger.press('Enter'); await close.click(); await expect(popover).toBeHidden(); await expect(trigger).toBeFocused();
        }
        // Load all below-fold images before the full-page review screenshot.
        for (const img of await page.locator('.demo-zoom img').all()) { await img.scrollIntoViewIfNeeded(); await expect(img).toHaveJSProperty('complete', true); }
        await page.evaluate(() => globalThis.scrollTo(0, 0));
        // Playwright's WebKit screenshotter always injects a "body {}" stylesheet to sync animations.
        // Keep its CSP check clean: export review images from Chromium/Firefox; exercise all controls in WebKit.
        if (name !== 'webkit') await page.screenshot({ path: resolve(output, `${name}-${width}-${theme}.png`), fullPage: true, caret: 'initial' });
        expect(requests.every(url => url.startsWith(origin + '/'))).toBe(true); expect(failures).toEqual([]);
        results.push({ browser: name, width, theme, lightboxes: 10, overflow: false, cspViolations: failures.length });
        await context.close();
      }
    } finally { await browser.close(); }
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ initialBytes: Buffer.byteLength(html) + css.length + extra.length, results }, null, 2));
  console.log(JSON.stringify(results));
} finally { clearTimeout(timer); await new Promise(resolve => server.close(resolve)); }
