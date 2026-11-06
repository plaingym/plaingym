// SPDX-License-Identifier: AGPL-3.0-only
// Optional layout/interaction check: install the pinned e2e tooling first. No production services are started.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const { chromium, expect } = await import(new URL('e2e/node_modules/@playwright/test/index.mjs', 'file:///' + root.replaceAll('\\', '/')).href);
const { default: AxeBuilder } = await import(new URL('e2e/node_modules/@axe-core/playwright/dist/index.mjs', 'file:///' + root.replaceAll('\\', '/')).href);
const output = resolve(root, 'coverage/bookings/browser');
await mkdir(output, { recursive: true });
const fixture = resolve(root, 'apps/web/coverage/bookings/fixture.tsx');
await mkdir(resolve(root, 'apps/web/coverage/bookings'), { recursive: true });
const modulePath = path => '/@fs/' + resolve(root, path).replaceAll('\\', '/');
await writeFile(fixture, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '${modulePath('apps/web/src/app/context.tsx')}';
import { BookingRosterPanel, MemberBookingsPanel } from '${modulePath('apps/web/src/features/bookings/panels.tsx')}';
import { bookingClient } from '${modulePath('apps/web/src/features/bookings/client.ts')}';
import { attendanceClient } from '${modulePath('apps/web/src/features/attendance/client.ts')}';
import { SessionDetail } from '${modulePath('apps/web/src/features/schedule/session.tsx')}';
import { Dialog } from '${modulePath('apps/web/src/components/ui/dialog.tsx')}';
import { MembershipPanel } from '${modulePath('apps/web/src/features/billing/memberships/member-tab.tsx')}';
import '${modulePath('apps/web/src/app/styles.css')}';
const memberId='member', sessionId='session';
const member={id:memberId, firstName:'Alexandria',lastName:'Rivera-Martinez'};
const session={id:sessionId,name:'Fundamentals and partner practice',startsAt:'2026-11-02T18:00:00Z',capacity:1};
let booking={id:'booking',memberId,sessionId,status:'booked',queueRank:null,waitlistPosition:null};
Object.assign(bookingClient, {
  member:async()=>member,members:async()=>[member],session:async()=>session,sessions:async()=>[session],
  list:async()=>({data:[booking],pagination:{total:1}}),
  roster:async()=>{if(window.failRoster)throw new Error('Unavailable');const gone=booking.status==='cancelled',waiting=booking.status==='waitlisted';
    return {data:gone?[]:[{booking,attendance:null}],pagination:{total:gone?0:1},counts:{booked:gone||waiting?0:1,waitlisted:waiting?1:0,checkedIn:2}};},
  book:async()=>{booking={...booking,status:'waitlisted',queueRank:2,waitlistPosition:3};return booking;},
  cancel:async()=>{booking={...booking,status:'cancelled',queueRank:null,waitlistPosition:null};return booking;}
});
Object.assign(attendanceClient, { members:async()=>({data:[member],total:1}), checkedIn:async()=>[], record:async()=>({id:'visit',memberId}) });
const dialogSession={id:sessionId,name:'Fundamentals',startsAt:'2026-11-02T18:00:00Z',endsAt:'2026-11-02T19:00:00Z',coachId:null,status:'scheduled',capacity:5,notes:null,kind:'class',programIds:[],tagIds:[],revision:1};
const options={timezone:'America/New_York',programs:[],coaches:[]};
const services={loadBootstrap:async()=>({gym:{timezone:'America/New_York'},session:{roles:['owner']}})};
const plan={id:'plan',name:'Unlimited classes',amountCents:12000,currency:'CAD',interval:'monthly'};
const membership={id:'membership',memberId,planId:plan.id,status:'active',amountCents:10000,currency:'CAD',interval:'monthly',startsOn:'2026-10-01',nextDueOn:'2026-11-01'};
const billing={plans:async()=>[plan],memberships:async()=>[membership]};
const memberView=new URL(location.href).searchParams.has('member'), dialogView=new URL(location.href).searchParams.has('dialog'), membershipView=new URL(location.href).searchParams.has('membership');
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><ShellServicesContext.Provider value={services}>
  <main className="mx-auto max-w-5xl p-4 sm:p-8"><h1 className="mb-6 text-2xl font-bold">Class reservations</h1>
  {dialogView?<Dialog title="Class details" closeLabel="Close" onClose={()=>undefined}><SessionDetail session={dialogSession} options={options} roles={['owner']} enabledModules={[]} onSaved={() => undefined}/></Dialog>:membershipView?<MembershipPanel gymId="gym" memberId={memberId} manage={false} client={billing}/>:memberView?<MemberBookingsPanel memberId={memberId}/>:<BookingRosterPanel sessionId={sessionId}/>}</main>
</ShellServicesContext.Provider></QueryClientProvider>);
`);
const server = await createServer({ configFile: false, appType: 'custom', root: resolve(root, 'apps/web'), plugins: [react(), tailwindcss()],
  server: { host: process.env.E2E_LOOPBACK ?? '127.0.0.1', port: 0, fs: { allow: [root] } },
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
});
server.middlewares.use('/bookings-fixture', async (req, res) => {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking panels</title></head><body><div id="root"></div><script type="module" src="' + modulePath('apps/web/coverage/bookings/fixture.tsx') + '"></script></body></html>';
  res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url ?? '/', html));
});
let browser;
const timer = setTimeout(() => { console.error('Booking browser check timed out'); process.exit(1); }, 120_000);
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = 'http://' + address.address + ':' + address.port;
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const errors = [], results = [];
  for (const width of [360, 1280]) for (const member of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/bookings-fixture' + (member ? '?member' : ''));
    await expect(page.getByText('Booked', { exact: true })).toBeVisible();
    if (member) await page.getByLabel('Class', { exact: true }).selectOption('session');
    else {
      await page.getByLabel('Member name').fill('Alexandria'); await page.getByRole('button', { name: 'Search members' }).click();
      await page.getByLabel('Member', { exact: true }).selectOption('member');
    }
    await page.getByRole('button', { name: 'Book a place', exact: true }).click();
    await expect(page.getByText('Added to the waitlist at position 2.')).toBeVisible();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    const small = await page.locator('button, input:not([type=checkbox]), select, label:has(input[type=checkbox])').evaluateAll(elements => elements.filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width > 0 && (bounds.height < 44 || bounds.width < 44);
    }).map(element => element.outerHTML));
    expect(small).toEqual([]);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: resolve(output, (member ? 'member-' : 'session-') + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: /^Cancel booking for/ }).click();
    await expect(page.getByText('Booking cancelled.')).toBeVisible();
    results.push({ width, panel: member ? 'member' : 'session', overflow: false, minimumTarget: 44, axeViolations: 0, bookCancel: true });
    await context.close();
  }
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/bookings-fixture?dialog');
    await expect(page.getByTestId('session-counts')).toHaveText('Booked 1 of 5 · 0 waitlisted · 2 checked in');
    await expect(page.getByTestId('roster-counts')).toHaveText('Booked 1 · 0 waitlisted · 2 checked in');
    for (const id of ['session-counts', 'roster-counts']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box.x >= 0 && box.x + box.width <= width).toBe(true);
    }
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await page.evaluate(() => { globalThis.failRoster = true; globalThis.dispatchEvent(new Event('focus')); });
    await expect(page.getByText(/These bookings and counts may be out of date/)).toBeVisible();
    await expect(page.getByTestId('session-counts')).toHaveText('Booked 1 of 5 · 0 waitlisted · 2 checked in');
    await page.getByText(/These bookings and counts may be out of date/).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, 'dialog-stale-' + width + '.png'), fullPage: true });
    await page.evaluate(() => { globalThis.failRoster = false; globalThis.dispatchEvent(new Event('focus')); });
    await expect(page.getByText(/These bookings and counts may be out of date/)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: /^Cancel booking for/ }).click();
    await expect(page.getByTestId('session-counts')).toHaveText('Booked 0 of 5 · 0 waitlisted · 2 checked in');
    results.push({ width, panel: 'dialog', overflow: false, summaryUpdates: true, staleRecovery: true });
    await context.close();
  }
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/bookings-fixture?membership');
    await expect(page.getByText('Plan price now CA$120.00 / Monthly')).toBeVisible();
    await expect(page.getByText('Active · CA$100.00 / Monthly')).toBeVisible();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: resolve(output, 'membership-' + width + '.png'), fullPage: true });
    results.push({ width, panel: 'membership', overflow: false, axeViolations: 0 });
    await context.close();
  }
  expect(errors).toEqual([]); await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { clearTimeout(timer); await browser?.close(); await server.close(); }
