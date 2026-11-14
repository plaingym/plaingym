// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client, clientAddress } from '../support.js';
import { accessibleLayout } from '../responsive.js';

test.use({ trace: 'off', screenshot: 'off' });
for (const { role, width, pagePath } of [
  { role: 'owner', width: 360, pagePath: '/admin/members' },
  { role: 'student', width: 1280, pagePath: '/portal' },
] as const) {
  test(`showcase ${role} makes an isolated copy on the same page at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': clientAddress() });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('https://demo.localhost/demo');
    await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
    await page.waitForURL(url => url.hostname === 'showcase.demo.localhost');
    await page.getByRole('button', { name: `Sign in as ${role}`, exact: true }).click();
    await page.waitForURL(url => url.pathname === (role === 'student' ? '/portal' : '/admin'));
    await page.goto('https://showcase.demo.localhost' + pagePath);
    await expect(page.getByRole('button', { name: 'Make my own copy', exact: true })).toBeVisible();
    // This reaches the shared refusal before body validation or the route's write handler.
    expect(await page.evaluate(async () => (await fetch('/api/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status)).toBe(403);
    const prompt = page.getByRole('dialog', { name: 'Shared demo', exact: true });
    await expect(prompt).toBeVisible();
    await accessibleLayout(page, info, 'demo-copy-' + width);
    await page.screenshot({ path: info.outputPath('demo-copy-' + width + '.png'), fullPage: true });
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/demo/sandboxes' && response.request().method() === 'POST');
    await prompt.getByRole('button', { name: 'Make my own copy', exact: true }).click();
    expect((await created).status(), 'Signed-in showcase copy creation').toBe(201);
    await page.waitForURL(url => url.hostname.endsWith('.demo.localhost') && url.hostname !== 'showcase.demo.localhost' && url.pathname === pagePath && !url.hash);
    const client = new Client(new URL(page.url()).origin);
    client.cookie = (await page.context().cookies(client.origin)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const bootstrap = await client.json<{ data: { session: { roles: string[]; member: boolean } } }>('/api/auth/bootstrap');
    expect(bootstrap.data.session).not.toBeNull();
    if (role === 'student') expect(bootstrap.data.session.member).toBe(true);
    else expect(bootstrap.data.session.roles).toContain('owner');
    const refusal = await client.request<{ error?: { details?: { reason?: string[] } } }>('/api/members', 'POST', {});
    expect(refusal.body.error?.details?.reason ?? []).not.toContain('demo_showcase_read_only');
  });
}
