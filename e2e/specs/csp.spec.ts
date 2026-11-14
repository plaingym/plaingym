// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, demoClient, gymOrigin, type RecordId, type Sandbox } from '../support.js';
import { outboxIds, outboxLink, stripeOrigin } from '../portal.js';

// Every spec fails on a Content-Security-Policy violation in the browser console (`cspGuard` in support.ts). These
// tests open the pages no other spec does, and the Checkout starts that leave the app from a policy that allows only
// its own origin in form-action: each starts with a navigation, never a form submission.
// Signed links, invitation links and sign-in links are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });

test('the policy is enforced: an inline script and style without the nonce are blocked and fail the test', async ({ page, cspViolations }) => {
  const response = await page.goto(gymOrigin + '/login');
  const headers = await response!.allHeaders();
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy-report-only']).toBeUndefined();
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.injected = true;';
    document.head.append(script);
    const style = document.createElement('style');
    style.textContent = 'body { display: none; }';
    document.head.append(style);
  });
  expect(await page.evaluate(() => (window as { injected?: boolean }).injected)).toBeUndefined();
  await expect(page.locator('body')).toBeVisible();
  await expect.poll(() => cspViolations.length).toBeGreaterThanOrEqual(2);
  expect(cspViolations.join('\n')).toMatch(/inline script/);
  expect(cspViolations.join('\n')).toMatch(/inline style/);
  // Both were expected; the guard checks only what follows.
  cspViolations.length = 0;
});

test('the staff invitation page runs its inline script with the response nonce', async ({ page, install }) => {
  const email = `csp-${Date.now()}@example.test`;
  const invite = await install.clients.owner.json<{ data: { invitationUrl: string } }>('/api/staff/invitations', 'POST',
    { email, role: 'coach', delivery: 'print' });
  const url = new URL(invite.data.invitationUrl);
  expect(url.hash.length).toBeGreaterThan(1);
  await page.goto(gymOrigin + url.pathname + url.hash);
  await expect(page.locator('form#invite')).toBeVisible();
  // The script removes the token from the address bar as soon as it runs.
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('main')).toHaveCSS('max-width', '672px');
    await expect(page.locator('h1')).toHaveCSS('font-size', width === 360 ? '24px' : '30px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('the public pages load under their own policies', async ({ page, sandboxes }) => {
  const sandbox = sandboxes[0]!;
  for (const path of ['/trial', '/drop-in', '/join']) {
    const response = await page.goto(sandbox.origin + path);
    expect(response?.status(), path).toBeLessThan(400);
    await expect(page.locator('h1').first(), path).toBeVisible();
  }
});

/** The sandbox student's household, with one open invoice it can pay. */
async function studentBill(sandbox: Sandbox) {
  const owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
  const household = (await student.json<{ data: RecordId }>('/api/portal/household')).data;
  const dueOn = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const bill = (await owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id, dueOn,
    source: 'custom', description: 'Policy check', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
  return { owner, student, householdId: household.id, invoiceId: bill.id };
}

test('a pay link and a card link start Checkout with a navigation', async ({ page, sandboxes }) => {
  const sandbox = sandboxes[0]!, { owner, householdId, invoiceId } = await studentBill(sandbox);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  for (const [purpose, extra, button] of [['pay_invoice', { invoiceId }, 'Pay securely with Stripe'],
    ['update_card', {}, 'Add or update card securely']] as const) {
    const link = await owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose, householdId, expiresAt, ...extra });
    await page.goto(sandbox.origin + '/l/' + link.data.token);
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.waitForURL(url => url.origin === stripeOrigin);
  }
});

test('the portal starts Checkout for an invoice and for a card with a navigation', async ({ page, context, sandboxes }) => {
  const sandbox = sandboxes[0]!, { student } = await studentBill(sandbox);
  await student.browser(context);
  await page.goto(sandbox.origin + '/portal/billing');
  await page.getByRole('button', { name: 'Pay now', exact: true }).first().click();
  await page.waitForURL(url => url.origin === stripeOrigin);
  await page.goto(sandbox.origin + '/portal/billing');
  await page.getByRole('button', { name: /^(Add a card|Update card)$/ }).click();
  await page.waitForURL(url => url.origin === stripeOrigin);
});

test('the outbox preview shows an email with its inline styles, under the preview\'s own policy', async ({ page, context, sandboxes }) => {
  // The second sandbox: demo-links.spec.ts opens the newest signed link mailed to the first sandbox's first household
  // with an email, so a link sent there would replace its onboarding link.
  const sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
  const initial = (await owner.json<{ data: RecordId & { memberEmailsEnabled: boolean } }>('/api/settings/go-live')).data;
  try {
    if (!initial.memberEmailsEnabled) await owner.json('/api/settings/go-live', 'PATCH', { revision: initial.revision, memberEmailsEnabled: true });
    const household = (await owner.json<{ data: { id: string; email: string | null }[] }>('/api/households?limit=100')).data.find(home => home.email)!;
    const before = await outboxIds(owner);
    await owner.json('/api/links/send', 'POST', { sendGeneration: crypto.randomUUID(), purpose: 'update_card', householdId: household.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await outboxLink(owner, household.email!, /^\/l\//, before);
    const message = (await owner.json<{ data: { id: string; subject: string; recipient: string }[] }>('/api/demo/outbox?limit=100')).data
      .find(entry => entry.recipient === household.email && !before.has(entry.id))!;
    await owner.browser(context);
    await page.goto(sandbox.origin + '/admin/outbox');
    const card = page.locator('h2', { hasText: message.subject }).first().locator('..');
    await card.getByRole('button', { name: 'Preview HTML', exact: true }).click();
    const frame = page.getByRole('dialog').locator('iframe');
    await expect(frame).toHaveAttribute('src', `/api/demo/outbox/${message.id}/preview`);
    await expect(frame).toHaveAttribute('sandbox', '');
    // The dialog's Tab wrap still lets a keyboard reach (and scroll) the preview.
    await page.getByRole('button', { name: 'Close message preview' }).focus();
    await page.keyboard.press('Tab');
    await expect(frame).toBeFocused();
    // The layout's inline styles apply.
    const body = frame.contentFrame().locator('body');
    await expect(body).toHaveCSS('background-color', 'rgb(243, 244, 246)');
  } finally {
    if (!initial.memberEmailsEnabled) {
      const current = (await owner.json<{ data: RecordId }>('/api/settings/go-live')).data;
      await owner.json('/api/settings/go-live', 'PATCH', { revision: current.revision, memberEmailsEnabled: false });
    }
  }
});
