// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { sizes } from '../responsive.js';

/** The UX pass captures only when asked, so CI's End-to-end run doesn't get longer. */
export const uxPass = process.env.UX_PASS === '1';
/** Git-ignored, like the rest of `coverage/`: screenshots and videos never enter a commit. */
export const outputRoot = new URL('../coverage/ux-pass/', import.meta.url);
const manifestFile = new URL('manifest.json', outputRoot);

export type Theme = 'light' | 'dark';
export const themes: readonly Theme[] = ['light', 'dark'];
const sizeName = (width: number) => width <= 360 ? 'phone' : width <= 768 ? 'tablet' : 'desktop';

export interface Shot {
  surface: string; screen: string; state: 'populated' | 'empty'; size: string; width: number; height: number; theme: Theme;
  file: string; bytes: number;
  /** The light image this dark one matches pixel for pixel (the app has no dark theme), when it does. */
  sameAs?: string;
}
export interface Gap { surface: string; screen: string; state: 'populated' | 'empty'; reason: string }
export interface Video { name: string; file: string }
interface Manifest { generatedAt: string; sizes: typeof sizes; themes: readonly Theme[]; shots: Shot[]; gaps: Gap[]; videos: Video[] }

async function readManifest(): Promise<Manifest> {
  try { return JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { generatedAt: new Date().toISOString(), sizes, themes, shots: [], gaps: [], videos: [] };
}
/** Read, change and replace the manifest; the rename means an interrupted run never leaves half a file. */
async function updateManifest(change: (manifest: Manifest) => void) {
  await mkdir(outputRoot, { recursive: true });
  const manifest = await readManifest();
  change(manifest);
  manifest.generatedAt = new Date().toISOString();
  const temporary = new URL(`manifest-${randomUUID()}.tmp`, outputRoot);
  await writeFile(temporary, JSON.stringify(manifest, null, 2));
  await rename(temporary, manifestFile);
}
/** A fresh manifest for a new capture run (the images of an earlier run are overwritten screen by screen). */
export async function resetManifest() {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(manifestFile, JSON.stringify({ generatedAt: new Date().toISOString(), sizes, themes, shots: [], gaps: [], videos: [] }, null, 2));
}
export async function recordVideo(name: string, file: string) {
  await updateManifest((manifest) => { manifest.videos = [...manifest.videos.filter((video) => video.name !== name), { name, file }]; });
}

/** The names of a screen's visible buttons, in `buttons.json`: what a reviewer can open from it that the walk didn't. */
export async function recordButtons(page: Page, key: string) {
  const names = await page.locator('#main-content button:visible, main button:visible').evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)))]);
  const file = new URL('buttons.json', outputRoot);
  let all: Record<string, string[]> = {};
  try { all = JSON.parse(await readFile(file, 'utf8')) as Record<string, string[]>; } catch { /* the first screen */ }
  all[key] = names;
  await writeFile(file, JSON.stringify(all, null, 2));
}

/** Waits until the page has nothing loading, its fonts are in and finite transitions have ended. */
export async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(150);
}

/**
 * Captures screens: each one full-page at the three sizes in `responsive.ts`, in light and dark, named
 * `<surface>/<screen>-<size>-<theme>.png`, and listed in `manifest.json`. A screen that can't be reached is listed as a gap.
 */
export class Capture {
  constructor(readonly surface: string, readonly state: 'populated' | 'empty' = 'populated') {}

  async shoot(page: Page, screen: string, options: { scrollTop?: boolean; fullPage?: boolean } = {}) {
    const shots: Shot[] = [];
    const original = page.viewportSize();
    await mkdir(new URL(this.surface + '/', outputRoot), { recursive: true });
    for (const size of sizes) {
      await page.setViewportSize(size);
      const light: { buffer?: Buffer; file?: string } = {};
      for (const theme of themes) {
        await page.emulateMedia({ colorScheme: theme });
        await settle(page);
        if (options.scrollTop !== false) await page.evaluate(() => scrollTo(0, 0));
        const dialog = page.getByRole('dialog').last();
        const scrollDialog = async (reset: boolean) => dialog.evaluate((root, reset) => {
          let changed = false;
          for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
            if (element.clientHeight === 0 || !['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) continue;
            const before = element.scrollTop;
            element.scrollTop = reset ? 0 : before + Math.max(1, Math.floor(element.clientHeight * 0.8));
            changed ||= element.scrollTop !== before;
          }
          return changed;
        }, reset);
        if (await dialog.count()) await scrollDialog(true);
        const file = `${this.surface}/${screen}-${sizeName(size.width)}-${theme}.png`;
        // An open dialog is fixed to the screen: by default, capture what the screen shows rather than the page behind it.
        const fullPage = options.fullPage ?? !await page.getByRole('dialog').count();
        const buffer = await page.screenshot({ fullPage, animations: 'disabled', caret: 'hide' });
        await writeFile(new URL(file, outputRoot), buffer);
        const shot: Shot = { surface: this.surface, screen, state: this.state, size: sizeName(size.width), width: size.width, height: size.height,
          theme, file, bytes: buffer.length };
        if (theme === 'light') Object.assign(light, { buffer, file });
        else if (light.buffer?.equals(buffer)) shot.sameAs = light.file;
        shots.push(shot);
        // A full-page screenshot cannot see inside a fixed dialog's scrolling body. Keep overlapping views to its end.
        if (await dialog.count()) {
          for (let index = 1; await scrollDialog(false); index++) {
            if (index > 50) throw new Error('Dialog capture exceeded 50 scrolling views');
            const scrolledScreen = `${screen}-scroll-${index}`;
            const scrolledFile = `${this.surface}/${scrolledScreen}-${sizeName(size.width)}-${theme}.png`;
            const scrolled = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' });
            await writeFile(new URL(scrolledFile, outputRoot), scrolled);
            shots.push({ surface: this.surface, screen: scrolledScreen, state: this.state, size: sizeName(size.width),
              width: size.width, height: size.height, theme, file: scrolledFile, bytes: scrolled.length });
          }
        }
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    if (original) await page.setViewportSize(original);
    await updateManifest((manifest) => {
      manifest.shots = [...manifest.shots.filter((shot) => !(shot.surface === this.surface
        && (shot.screen === screen || shot.screen.startsWith(screen + '-scroll-')))), ...shots];
      manifest.gaps = manifest.gaps.filter((gap) => !(gap.surface === this.surface && gap.screen === screen));
    });
  }

  async gap(screen: string, reason: string) {
    await updateManifest((manifest) => {
      manifest.gaps = [...manifest.gaps.filter((gap) => !(gap.surface === this.surface && gap.screen === screen)),
        { surface: this.surface, screen, state: this.state, reason: reason.split('\n')[0]!.slice(0, 300) }];
    });
  }

  /** Runs one screen's steps and captures it; a failure is recorded as a gap and the walk goes on to the next screen. */
  async step(page: Page, screen: string, reach: () => Promise<void>, options?: { scrollTop?: boolean; fullPage?: boolean }) {
    try {
      await reach();
      await this.shoot(page, screen, options);
      return true;
    } catch (error) {
      await this.gap(screen, error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

/** A context like `mobile-screens.spec.ts` opens: touch on, so the phone size is a touch device; the walk resizes it per shot. */
export async function openContext(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ viewport: sizes[0], hasTouch: true, ignoreHTTPSErrors: true, ...options });
  return [context, await context.newPage()];
}

/**
 * Presses a screen's action and waits for what it opens: a dialog, returned, or a form in the page itself, when no
 * dialog appears (closing either is up to the caller).
 */
export async function openDialog(page: Page, button: Locator) {
  await expect(button.first()).toBeVisible({ timeout: 5_000 });
  await button.first().click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible({ timeout: 3_000 }).catch(() => undefined);
  await settle(page);
  return dialog;
}
export async function closeDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  if (!await dialog.count()) return;
  const close = dialog.last().getByRole('button', { name: /^(Close dialog|Close|Cancel)$/ });
  if (await close.count()) await close.first().click().catch(() => undefined);
  if (await dialog.count()) await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
}
