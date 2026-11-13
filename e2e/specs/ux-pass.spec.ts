// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, Client, demoClient, gymOrigin, password, type RecordId, type Sandbox } from '../support.js';
import { sizes } from '../responsive.js';
import { Capture, closeDialog, openContext, openDialog, outputRoot, recordButtons, recordVideo, resetManifest, settle, uxPass } from '../ux-pass/capture.js';
import { adminScreens, updateStates, type AdminScreen } from '../ux-pass/screens.js';

// The final UX pass: every surface at three sizes in light and dark, for a person (or agent) to review image by image.
// It runs only with UX_PASS=1 (`e2e/ux-pass/README.md`), in its own Playwright project, before any other spec touches the install.
test.skip(!uxPass, 'The UX pass captures only with UX_PASS=1');
// Sign-in links, invitation tokens and device tokens are bearer credentials: no traces. The images are the output.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.beforeEach(() => { test.setTimeout(40 * 60_000); });

const setupToken = () => process.env.E2E_SETUP_TOKEN!;
const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { name, exact: typeof name === 'string' }).first();
async function visit(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
}
/** The admin menu's link when it exists, else a direct load: like a user, and without refetching the shell each time. */
async function adminGo(page: Page, origin: string, path: string) {
  const link = page.locator(`#admin-navigation a[href="${path}"]`);
  if (await link.count() && new URL(page.url()).origin === origin) {
    if (!await link.isVisible()) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await link.click();
    await expect(page).toHaveURL(origin + path);
  } else await page.goto(origin + path);
  await settle(page);
}

test('setup wizard: every step of a fresh install', async ({ page }) => {
  await resetManifest();
  const capture = new Capture('setup', 'empty');
  const guest = new Client(gymOrigin);
  expect((await guest.request('/api/setup')).status, 'the UX pass starts on a fresh install').toBe(200);
  const save = () => page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await capture.step(page, 'start', async () => {
    await page.goto(gymOrigin + '/setup#token=' + setupToken());
    await expect(heading(page, 'Start fresh or restore a backup')).toBeVisible();
  });
  await capture.step(page, 'restore', async () => {
    await page.getByRole('button', { name: 'Restore a backup', exact: true }).click();
    await expect(page.getByLabel('Snapshot ID or snapshots/ID/ prefix')).toBeVisible();
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await capture.step(page, 'owner', async () => { await expect(heading(page, 'Create your owner account')).toBeVisible(); });
  await capture.step(page, 'owner-errors', async () => {
    await save();
    await expect(page.getByLabel('Your name', { exact: true })).toBeFocused();
  });
  await page.getByLabel('Your name', { exact: true }).fill('QA Owner');
  await page.getByLabel('Email address', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('Password (12–128 characters)', { exact: true }).fill(password);
  await save();
  await capture.step(page, 'gym', async () => { await expect(heading(page, 'Gym details')).toBeVisible(); });
  await capture.step(page, 'gym-errors', async () => {
    await save();
    await expect(page.getByLabel('Gym name', { exact: true })).toBeFocused();
  });
  await page.getByLabel('Gym name', { exact: true }).fill('QA academy');
  await page.getByLabel('IANA timezone', { exact: true }).fill('UTC');
  await save();
  await capture.step(page, 'packs', async () => { await expect(page.getByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ })).toBeVisible(); });
  await page.getByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ }).check();
  await save();
  await capture.step(page, 'website', async () => { await expect(heading(page, 'Your website')).toBeVisible(); });
  // The built-in website, so the fresh gym's public site can be captured empty.
  await page.getByRole('radio', { name: 'Use the built-in website', exact: true }).check();
  await save();
  await capture.step(page, 'email', async () => { await expect(heading(page, 'Email delivery')).toBeVisible(); });
  await page.getByRole('button', { name: 'Skip email configuration', exact: true }).click();
  await capture.step(page, 'google', async () => { await expect(heading(page, 'Google sign-in (optional)')).toBeVisible(); });
  await page.getByRole('button', { name: 'Skip Google sign-in', exact: true }).click();
  await capture.step(page, 'payments', async () => { await expect(page.getByLabel('Restricted Stripe key', { exact: true })).toBeVisible(); });
  await page.getByRole('button', { name: 'Set up later', exact: true }).click();
  await capture.step(page, 'backups', async () => { await expect(heading(page, 'Protect your gym with backups')).toBeVisible(); });
  await page.getByRole('button', { name: 'Set up later', exact: true }).click();
  await capture.step(page, 'finish', async () => { await expect(heading(page, 'Import or start fresh')).toBeVisible(); });
  await capture.step(page, 'import', async () => {
    await page.getByRole('button', { name: 'Import a CSV', exact: true }).click();
    await expect(page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true })).toBeVisible();
  });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await capture.step(page, 'complete', async () => {
    await expect(page.getByText('Setup is complete. Billing and member emails are off until you turn them on.', { exact: true })).toBeVisible();
  });
  expect((await guest.request('/api/setup')).status, 'setup finished').toBe(404);
});

/** Each admin screen, its tabs and its dialogs. */
async function walkAdmin(page: Page, capture: Capture, origin: string, screens: readonly AdminScreen[]) {
  for (const screen of screens) {
    const reach = async () => {
      if (screen.open) await screen.open(page, origin);
      else await adminGo(page, origin, screen.path);
      await expect(page.locator('#main-content h1, main h1').first()).toBeVisible();
    };
    if (!await capture.step(page, screen.name, reach)) continue;
    await recordButtons(page, `${capture.surface}/${screen.name}`);
    if (screen.tabs) {
      const tabs = await page.getByRole('tab').all();
      const names = await Promise.all(tabs.map((tab) => tab.innerText()));
      for (const [index, tab] of tabs.entries()) {
        if (index === 0) continue;
        const name = names[index]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await capture.step(page, `${screen.name}-tab-${name}`, async () => {
          await tab.click();
          await expect(tab).toHaveAttribute('aria-selected', 'true');
        });
      }
    }
    // Each action starts from the screen as it loads: a form opened in the page stays open until it is reloaded.
    const actions = [...(screen.dialogs ?? []).map((dialog) => ({ name: 'dialog-' + dialog.name, run: async () => {
      const opened = await openDialog(page, page.locator('#main-content, main').first().getByRole('button', { name: dialog.button, exact: true }));
      if (dialog.then) await dialog.then(opened, page);
    } })), ...(screen.extras ?? []).map((extra) => ({ name: extra.name, run: () => extra.reach(page, origin) }))];
    for (const action of actions) {
      await capture.step(page, `${screen.name}-${action.name}`, async () => { await reach(); await action.run(); });
      await closeDialog(page);
    }
  }
}

/** The update banner in each state it can show, through the browser's answer for the release check. */
async function captureUpdateBanner(page: Page, capture: Capture, origin: string) {
  for (const [name, data] of Object.entries(updateStates())) {
    await page.route(origin + '/api/health/update', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) }));
    await capture.step(page, 'update-banner-' + name, async () => {
      await page.goto(origin + '/admin');
      await expect(page.getByTestId('update-banner')).toBeVisible();
    }, { fullPage: false });
    await page.unroute(origin + '/api/health/update');
  }
}

/** Kiosk screens on a registered device: the start screen, both ways in, and a name search. */
async function walkKiosk(page: Page, capture: Capture, origin: string, member?: { name: string; pin: string }) {
  await capture.step(page, 'start', async () => { await expect(page.getByRole('button', { name: 'Name and PIN', exact: true })).toBeVisible(); });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [{ kind: 'videoinput' }], getUserMedia: async () => { throw new Error('permission denied'); },
    } });
  });
  await capture.step(page, 'qr-camera-blocked', async () => {
    await page.getByRole('button', { name: 'Scan a QR code', exact: true }).click();
    await expect(page.getByText(/Allow camera access/)).toBeVisible();
  });
  await page.getByRole('button', { name: 'Start over', exact: true }).click().catch(() => undefined);
  await capture.step(page, 'name-pin', async () => {
    await page.getByRole('button', { name: 'Name and PIN', exact: true }).click();
    await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  });
  await capture.step(page, member ? 'household' : 'not-found', async () => {
    await page.getByLabel('Your name', { exact: true }).fill(member?.name ?? 'Nobody Here');
    for (const digit of member?.pin ?? '9999') await page.getByRole('button', { name: digit, exact: true }).click();
    await page.getByRole('button', { name: 'Find me', exact: true }).click();
    if (member) await expect(page.getByRole('checkbox').first()).toBeVisible();
    else await expect(page.getByRole('alert').or(page.getByRole('status')).first()).toBeVisible();
  });
  if (!member) return;
  await capture.step(page, 'choose-class', async () => {
    await page.getByRole('button', { name: 'Check in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open mat', exact: true }).first()).toBeVisible();
  });
  await capture.step(page, 'checked-in', async () => {
    for (const button of await page.getByRole('button', { name: 'Open mat', exact: true }).all()) await button.click();
    await expect(page.getByText(/Checked in|Already checked in/).first()).toBeVisible();
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click().catch(() => undefined);
}

/** The core public pages, the forms empty and then refused for missing fields, on any gym. */
async function walkPublic(page: Page, capture: Capture, origin: string) {
  for (const kind of ['trial', 'drop-in'] as const) {
    if (!await capture.step(page, kind, async () => { await visit(page, origin + '/' + kind); await expect(page.locator('h1').first()).toBeVisible(); })) continue;
    const submit = page.locator('main form button[type=submit]').first();
    // A drop-in page with no fee listed has no form, only how to reach the gym.
    if (!await submit.count()) continue;
    await capture.step(page, kind + '-errors', async () => {
      await submit.click();
      await settle(page);
    });
  }
  await capture.step(page, 'join', async () => { await visit(page, origin + '/join'); await expect(page.locator('h1').first()).toBeVisible(); });
  const choose = page.getByRole('link', { name: /^Choose / });
  if (await choose.count()) {
    await capture.step(page, 'join-form', async () => {
      await choose.first().click();
      await expect(heading(page, /^Join: /)).toBeVisible();
    });
    await capture.step(page, 'join-form-errors', async () => {
      await page.getByRole('button', { name: /^(Continue to payment|Join|Submit)/ }).first().click();
      await settle(page);
    });
  }
  for (const site of ['home', 'programs', 'schedule', 'plans', 'coaches', 'contact']) {
    await capture.step(page, 'website-' + site, async () => {
      const response = await page.goto(origin + (site === 'home' ? '/' : '/' + site));
      expect(response?.status(), 'the website page answers').toBeLessThan(400);
      expect(new URL(page.url()).pathname, 'the website is on').toBe(site === 'home' ? '/' : '/' + site);
      await settle(page);
    });
  }
}

test('a fresh gym: empty admin screens, kiosk, public pages and sign-in', async ({ browser, install }) => {
  const admin = new Capture('admin-empty', 'empty');
  const [context, page] = await openContext(browser);
  try {
    await new Capture('sign-in', 'empty').step(page, 'login', async () => {
      await visit(page, gymOrigin + '/login');
      await expect(page.getByRole('button').first()).toBeVisible();
    });
    await install.clients.owner.browser(context);
    await page.goto(gymOrigin + '/admin');
    await walkAdmin(page, admin, gymOrigin, adminScreens({ populated: false }));
    await captureUpdateBanner(page, new Capture('update-banner', 'empty'), gymOrigin);
    await context.clearCookies();
    await walkPublic(page, new Capture('public-empty', 'empty'), gymOrigin);
    // A staff invitation's own page, signed out, as the invited person sees it.
    const invite = await install.clients.owner.json<{ data: { invitationUrl: string } }>('/api/staff/invitations', 'POST',
      { email: `ux-${Date.now()}@example.invalid`, role: 'coach', delivery: 'print' });
    const url = new URL(invite.data.invitationUrl);
    await new Capture('sign-in', 'empty').step(page, 'staff-invitation', async () => {
      await page.goto(gymOrigin + url.pathname + url.hash);
      await expect(page.locator('form#invite')).toBeVisible();
    });
  } finally { await context.close(); }

  // The kiosk on a fresh gym: the device token form, then a search that finds nobody.
  const [kioskContext, kiosk] = await openContext(browser, { viewport: sizes[1] });
  try {
    const capture = new Capture('kiosk-empty', 'empty');
    await capture.step(kiosk, 'device-token', async () => {
      await visit(kiosk, gymOrigin + '/kiosk');
      await expect(kiosk.getByLabel('Device token', { exact: true })).toBeVisible();
    });
    await kiosk.getByLabel('Device token', { exact: true }).fill(install.token);
    await kiosk.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
    await walkKiosk(kiosk, capture, gymOrigin);
  } finally { await kioskContext.close(); }
  await new Capture('portal-empty', 'empty').gap('all',
    'A fresh single-gym install has no member with a portal sign-in; the portal is captured populated from the demo sandbox');
});

async function signedIn(browser: Browser, client: Client, viewport = sizes[0]): Promise<[BrowserContext, Page]> {
  const [context, page] = await openContext(browser, { viewport });
  await client.browser(context);
  return [context, page];
}

/** A household with an email, the student's household, an open invoice and a waiver template, for the signed links. */
async function linkFixtures(sandbox: Sandbox) {
  const owner = await demoClient(sandbox, 'owner'), student = await demoClient(sandbox, 'student');
  const household = (await student.json<{ data: RecordId }>('/api/portal/household')).data;
  const dueOn = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const invoice = (await owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id, dueOn,
    source: 'custom', description: 'Seminar fee', currency: 'USD', amountCents: 4500, taxRateIds: [] })).data;
  const members = (await owner.json<{ data: { id: string; householdId: string }[] }>('/api/members?limit=100')).data;
  return { owner, householdId: household.id, invoiceId: invoice.id, memberId: members.find((member) => member.householdId === household.id)?.id };
}

test('the demo sandbox: populated admin, portal, kiosk, signed links, public pages and the demo itself', async ({ browser, sandboxes }) => {
  const sandbox = sandboxes[0]!, origin = sandbox.origin;
  const owner = await demoClient(sandbox, 'owner');
  // The seeded sandbox has the website off; turn it on so its pages can be captured populated.
  const settings = (await owner.json<{ data: RecordId & { websiteEnabled: boolean } }>('/api/settings')).data;
  if (!settings.websiteEnabled) await owner.json('/api/settings', 'PATCH', { revision: settings.revision, websiteEnabled: true }).catch(() => undefined);

  // The demo's own pages, signed out.
  const [guestContext, guest] = await openContext(browser);
  try {
    const demo = new Capture('demo');
    await demo.step(guest, 'landing', async () => {
      await visit(guest, 'https://demo.localhost/');
      await expect(guest.getByRole('button', { name: 'Try the demo', exact: true })).toBeVisible();
    });
    await demo.step(guest, 'start-page', async () => { await visit(guest, origin + '/demo'); await expect(guest.locator('h1').first()).toBeVisible(); });
    await demo.step(guest, 'menu', async () => {
      await guest.getByRole('button', { name: 'Demo menu', exact: true }).click();
      await expect(guest.getByRole('dialog', { name: 'Demo menu', exact: true })).toBeVisible();
    });
    await closeDialog(guest);
    await new Capture('sign-in').step(guest, 'login-demo', async () => { await visit(guest, origin + '/login'); });
    await walkPublic(guest, new Capture('public'), origin);
  } finally { await guestContext.close(); }

  // Admin as the owner, every screen with its tabs and dialogs; then a coach's view.
  const [ownerContext, page] = await signedIn(browser, owner);
  try {
    await page.goto(origin + '/admin');
    await walkAdmin(page, new Capture('admin'), origin, adminScreens({ populated: true, owner }));
  } finally { await ownerContext.close(); }
  const [coachContext, coachPage] = await signedIn(browser, await demoClient(sandbox, 'coach'));
  try {
    const coach = new Capture('admin-coach');
    await coach.step(coachPage, 'dashboard', async () => { await visit(coachPage, origin + '/admin'); });
    await coach.step(coachPage, 'schedule', async () => { await adminGo(coachPage, origin, '/admin/schedule'); });
    await coach.step(coachPage, 'settings', async () => {
      await visit(coachPage, origin + '/admin/settings');
      await expect(coachPage.getByText('No settings available for your role', { exact: true })).toBeVisible();
    });
  } finally { await coachContext.close(); }

  // The member portal, as the demo's student.
  const [studentContext, portal] = await signedIn(browser, await demoClient(sandbox, 'student'));
  try {
    const capture = new Capture('portal');
    for (const [name, path] of [['home', '/portal'], ['schedule', '/portal/schedule'], ['checkin', '/portal/checkin'], ['progress', '/portal/progress'],
      ['billing', '/portal/billing'], ['waivers', '/portal/waivers'], ['household', '/portal/household'], ['account', '/portal/account']] as const) {
      await capture.step(portal, name, async () => { await visit(portal, origin + path); await expect(portal.locator('h1').first()).toBeVisible(); });
    }
    await capture.step(portal, 'schedule-class', async () => {
      await visit(portal, origin + '/portal/schedule');
      const book = portal.getByRole('button', { name: /^(Book|Join the waitlist|Cancel booking)/ }).first();
      if (!await book.isVisible()) await portal.getByRole('button', { name: 'Next week', exact: true }).click();
      await portal.getByRole('button', { name: /^(Book|Join the waitlist)/ }).first().click();
      await settle(portal);
    });
  } finally { await studentContext.close(); }

  // The kiosk on the sandbox's own device, with the sample household.
  const [kioskContext, kiosk] = await openContext(browser, { viewport: sizes[1] });
  try {
    await kiosk.goto(origin + '/kiosk');
    await kiosk.getByLabel('Device token', { exact: true }).fill(sandbox.kioskToken);
    await kiosk.getByRole('button', { name: 'Save and start check-in', exact: true }).click();
    await walkKiosk(kiosk, new Capture('kiosk'), origin, { name: 'Marcus Rivera', pin: '2468' });
  } finally { await kioskContext.close(); }

  // The signed-link pages: one of each purpose, and one that was revoked.
  const fixtures = await linkFixtures(sandbox);
  const [linkContext, linkPage] = await openContext(browser);
  try {
    const capture = new Capture('signed-links');
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const links: [string, Record<string, unknown>][] = [['pay_invoice', { invoiceId: fixtures.invoiceId }], ['update_card', {}],
      ['onboarding', {}], ['sign_waiver', { memberId: fixtures.memberId }]];
    let revoke: string | undefined;
    for (const [purpose, extra] of links) {
      await capture.step(linkPage, purpose.replace('_', '-'), async () => {
        const link = await fixtures.owner.json<{ data: { id: string; token: string } }>('/api/links', 'POST',
          { purpose, householdId: fixtures.householdId, expiresAt, ...extra });
        revoke ??= link.data.id;
        await visit(linkPage, origin + '/l/' + link.data.token);
        await expect(linkPage.locator('h1').first()).toBeVisible();
      });
    }
    await capture.step(linkPage, 'unavailable', async () => {
      if (revoke) await fixtures.owner.json('/api/links/' + revoke + '/revoke', 'POST', {});
      await linkPage.goto(origin + '/l/' + 'A'.repeat(43));
      await expect(heading(linkPage, /This link is unavailable/)).toBeVisible();
    });
  } finally { await linkContext.close(); }
});

/** Plays the demo as a visitor would, at one size, recorded with Playwright's `recordVideo`. */
async function demoWalk(browser: Browser, sandbox: Sandbox, name: string, viewport: { width: number; height: number }) {
  const directory = new URL(`videos/${name}/`, outputRoot);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 360, ignoreHTTPSErrors: true,
    recordVideo: { dir: fileURLToPath(directory), size: viewport } });
  const page = await context.newPage();
  const pause = () => page.waitForTimeout(1_200);
  try {
    await page.goto(sandbox.origin + '/demo'); await settle(page); await pause();
    await (await demoClient(sandbox, 'owner')).browser(context);
    for (const path of ['/admin', '/admin/members', '/admin/schedule', '/admin/billing/invoices', '/admin/billing/plans', '/admin/announcements', '/admin/reports', '/admin/settings']) {
      await adminGo(page, sandbox.origin, path).catch(() => undefined);
      await pause();
      await page.mouse.wheel(0, 600); await pause();
    }
    await page.locator('#main-content a[href^="/admin/members/"]').first().click().catch(() => undefined);
    await settle(page); await pause();
    await context.clearCookies();
    await (await demoClient(sandbox, 'student')).browser(context);
    for (const path of ['/portal', '/portal/schedule', '/portal/checkin', '/portal/progress', '/portal/billing']) {
      await page.goto(sandbox.origin + path).catch(() => undefined);
      await settle(page); await pause();
    }
    await page.goto(sandbox.origin + '/join'); await settle(page); await pause();
  } finally { await context.close(); }
  const video = page.video();
  if (video) {
    const file = `videos/demo-walk-${name}.webm`;
    await video.saveAs(fileURLToPath(new URL(file, outputRoot)));
    await rm(directory, { recursive: true, force: true });
    await recordVideo('demo-walk-' + name, file);
  }
}

test('demo walk videos at phone and desktop size', async ({ browser, sandboxes }) => {
  await demoWalk(browser, sandboxes[1]!, 'phone', sizes[0]!);
  await demoWalk(browser, sandboxes[1]!, 'desktop', sizes[2]!);
});
