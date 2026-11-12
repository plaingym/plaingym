// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { horizontalOverflow } from '../responsive.js';

interface Website {
  revision: number; logo: boolean; logoVersion: string | null;
  tagline: string | null; about: string | null; phone: string | null; email: string | null;
  primaryColor: string | null; accentColor: string | null; photos: { id: string; alt: string }[];
}

test('logo URLs follow the upload across website, core pages and admin previews at phone and desktop widths', async ({ page, install }, info) => {
  test.setTimeout(180_000);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#155e55'; context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#ffffff'; context.font = 'bold 60px sans-serif'; context.fillText('PG', 18, 85);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const owner = install.clients.owner;
  const settings = (await owner.json<{ data: { revision: number; websiteEnabled: boolean } }>('/api/settings')).data;
  if (!settings.websiteEnabled) await owner.json('/api/settings', 'PATCH', { revision: settings.revision, websiteEnabled: true });
  const read = async () => (await owner.json<{ data: Website }>('/api/website')).data;
  const original = await read();
  const editable = ({ revision, tagline, about, phone, email, primaryColor, accentColor, photos }: Website) =>
    ({ revision, tagline, about, phone, email, primaryColor, accentColor, photos });
  const upload = async () => (await owner.json<{ data: Website }>('/api/website/logo', 'POST', {
    revision: (await read()).revision, contentType: 'image/png', base64: png,
  })).data;
  try {
    const first = await upload();
    expect(first.logoVersion).toMatch(/^[a-f0-9]{12}$/);
    const saved = (await owner.json<{ data: Website }>('/api/website', 'PUT', { ...editable(first), tagline: 'A new tagline' })).data;
    expect(saved.logoVersion).toBe(first.logoVersion);
    const second = await upload();
    expect(second.logoVersion).not.toBe(first.logoVersion);
    const logoPath = '/public/pages/logo/' + second.logoVersion;
    await owner.browser(page.context());
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/', '/join', '/trial', '/drop-in', '/trial/received', '/drop-in/received']) {
        const response = await page.goto(gymOrigin + path);
        expect(response?.status(), path).toBe(200);
        const logo = page.locator(`img[src="${logoPath}"]`);
        await expect(logo, path).toBeVisible();
        expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), path).toBe(true);
        expect(await horizontalOverflow(page), path).toBeUndefined();
        await page.screenshot({ path: info.outputPath(`public-${path === '/' ? 'home' : path.slice(1).replaceAll('/', '-')}-${width}.png`) });
      }
      await page.goto(gymOrigin + '/admin/settings');
      const preview = page.getByRole('img', { name: 'Current logo' });
      await expect(preview).toHaveAttribute('src', logoPath);
      await preview.scrollIntoViewIfNeeded();
      await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      expect(await horizontalOverflow(page)).toBeUndefined();
      await page.screenshot({ path: info.outputPath(`admin-logo-${width}.png`) });
    }
  } finally {
    // Cleanup failures are recorded without replacing the failure that brought us here.
    const cleanup = async (description: string, action: () => Promise<unknown>) => {
      try { await action(); }
      catch (error) { info.annotations.push({ type: 'cleanup', description: description + ': ' + String(error) }); }
    };
    await cleanup('Restore website content', async () => {
      await owner.json('/api/website', 'PUT', { ...editable(original), revision: (await read()).revision });
    });
    await cleanup('Remove test logo', async () => {
      await owner.json('/api/website/logo', 'DELETE', { revision: (await read()).revision });
    });
    if (!settings.websiteEnabled) {
      await cleanup('Restore website toggle', async () => {
        const currentSettings = (await owner.json<{ data: { revision: number } }>('/api/settings')).data;
        await owner.json('/api/settings', 'PATCH', { revision: currentSettings.revision, websiteEnabled: false });
      });
    }
  }
});
