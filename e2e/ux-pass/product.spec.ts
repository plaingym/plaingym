// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { test, expect, demoClient, type Person, type RecordId } from '../support.js';
import { openContext, settle, themes } from './capture.js';
import { adminScreens } from './screens.js';
import type { Page } from '@playwright/test';

test.skip(process.env.DEMO_CAPTURE !== '1' || !!process.env.CI, 'Manual product screenshot capture only');
const root = new URL('../../apps/server/src/demo/', import.meta.url);
const destination = new URL('screenshots/', root);
const fixedTime = new Date('2026-11-16T12:00:00.000Z');

test('capture ten seeded product screens in both themes and densities', async ({ browser, sandboxes }) => {
  await mkdir(destination, { recursive: true });
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
  const members = (await owner.json<{ data: Person[] }>('/api/members?limit=100')).data;
  const member = members.find(row => row.firstName === 'Marcus' && row.lastName === 'Rivera');
  expect(member).toBeDefined();
  const household = (await student.json<{ data: RecordId }>('/api/portal/household')).data;
  const signer = (await owner.json<{ data: RecordId }>('/api/members', 'POST',
    { householdId: household.id, firstName: 'Sam', lastName: 'Unsigned', dateOfBirth: '1990-01-01' })).data;
  const link = (await owner.json<{ data: { token: string } }>('/api/links', 'POST',
    { purpose: 'sign_waiver', householdId: household.id, memberId: signer.id, expiresAt: '2026-11-17T12:00:00.000Z' })).data;
  const screens = adminScreens({ populated: true, owner });
  const manifest: Record<string, { width: number; height: number; light: string[]; dark: string[] }> = {};
  const evidence: { file: string; bytes: number }[] = [];
  // Convert Playwright's PNG bytes in a blank browser page; no image library, host font or external service.
  const encoderContext = await browser.newContext(), encoder = await encoderContext.newPage();
  const webp = async (png: Buffer) => Buffer.from(await encoder.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, png.toString('base64')));
  try {
    for (const key of ['members', 'ranks', 'schedule', 'kiosk', 'portal', 'billing', 'waivers', 'join', 'reports', 'server']) {
      // The Health overview excludes variable host disk/version details below its first row.
      const viewport = ['portal', 'waivers'].includes(key) ? { width: 390, height: 844 } : key === 'kiosk' ? { width: 768, height: 900 }
        : { width: 1280, height: key === 'server' ? 490 : 900 };
      const shot = manifest[key] = { ...viewport, light: [] as string[], dark: [] as string[] };
      const lightCaptures = new Map<number, { file: string; bytes: Buffer }>();
      for (const theme of themes) for (const density of [1, 2]) {
        const [context, page] = await openContext(browser, { viewport, deviceScaleFactor: density, colorScheme: theme, timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });
        try {
          await page.clock.setFixedTime(fixedTime);
          if (key === 'portal') { await student.browser(context); await page.goto(sandbox.origin + '/portal/progress'); }
          else if (key === 'waivers') { await page.goto(sandbox.origin + '/l/' + link.token); await expect(page.locator('canvas').first()).toBeVisible(); }
          else if (key === 'join') await page.goto(sandbox.origin + '/join');
          else if (key === 'kiosk') await kiosk(page, sandbox.origin, sandbox.kioskToken);
          else {
            await owner.browser(context);
            // The plan catalog avoids sequence numbers assigned by concurrent invoice seed work.
            const name = key === 'billing' ? 'plans' : key === 'server' ? 'health' : key;
            await page.goto(sandbox.origin + (key === 'members' ? '/admin/members/' + member!.id : screens.find(screen => screen.name === name)!.path));
          }
          await expect(page.locator('main h1, #main-content h1').first()).toBeVisible();
          await page.waitForLoadState('networkidle');
          await settle(page);
          await expect(page.locator('html')).toHaveCSS('color-scheme', theme === 'dark' ? 'dark' : 'light dark');
          if (key === 'ranks') {
            await page.getByLabel('Show ready members only', { exact: true }).uncheck();
            await settle(page);
            await page.getByRole('heading', { name: 'Ready for promotion', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.evaluate(() => scrollBy(0, -120));
          }
          // Freeze client time before navigation; the container clock fixes the seed and server labels too.
          const bytes = await webp(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
          expect(bytes.length, key + ' WebP budget').toBeLessThan(200_000);
          const light = lightCaptures.get(density);
          if (theme === 'dark' && light?.bytes.equals(bytes)) {
            shot.dark.push(light.file);
            continue;
          }
          const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
          const file = `${key}-${theme}-${density}x-${hash}.webp`;
          await writeFile(new URL(file, destination), bytes);
          shot[theme].push(file);
          evidence.push({ file, bytes: bytes.length });
          if (theme === 'light') lightCaptures.set(density, { file, bytes });
        } finally { await context.close(); }
      }
    }
    await writeFile(new URL('screenshots.json', root), JSON.stringify(manifest, null, 2) + '\n');
    // Remove only obsolete product captures, after the complete manifest has been written successfully.
    const keep = new Set(evidence.map(row => row.file));
    for (const file of await readdir(destination)) if (/^[a-z]+-(light|dark)-[12]x-[a-f0-9]{16}\.webp$/.test(file) && !keep.has(file)) await unlink(new URL(file, destination));
    await writeFile(new URL('../coverage/product-capture.json', import.meta.url), JSON.stringify({ fixedTime, shots: evidence }, null, 2) + '\n');
    console.log(`Captured ${evidence.length} images; largest ${Math.max(...evidence.map(row => row.bytes))} bytes`);
  } finally { await encoderContext.close(); }
});

async function kiosk(page: Page, origin: string, token: string) {
  await page.goto(origin + '/kiosk');
  await page.getByLabel('Device token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Name and PIN', exact: true })).toBeVisible();
}
