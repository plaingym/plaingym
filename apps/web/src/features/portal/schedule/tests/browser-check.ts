// SPDX-License-Identifier: AGPL-3.0-only
// Browser check for the portal schedule, check-in and progress pages against the built app and fixture API replies.
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium, expect } = await import(pathToFileURL(resolve('e2e/node_modules/@playwright/test/index.mjs')).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve('e2e/node_modules/@axe-core/playwright/dist/index.mjs')).href);
const output = resolve('coverage/portal/schedule-browser'), dist = resolve('apps/web/dist'); await mkdir(output, { recursive: true });
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const gym = id(1), household = id(2), parent = id(3), child = id(4), userId = id(5), program = id(6), first = id(7), second = id(8);
const bootstrap = { gym: { id: gym, name: 'A long gym name that must fit on a phone', timezone: 'UTC', currency: 'USD', enabledModules: [] },
  session: { userId, roles: [], member: true }, login: { password: true, magicLink: false } };
const day = 86_400_000, start = Math.ceil(Date.now() / day) * day;
const at = (offset: number) => new Date(start + offset).toISOString();
let role: 'payer' | 'member' = 'payer';
const bookings = new Map<string, { id: string; memberId: string; sessionId: string; status: 'booked' | 'waitlisted' }>();
bookings.set('locked', { id: id(20), memberId: parent, sessionId: id(11), status: 'booked' });
const sessions = [
  { id: id(10), name: 'Fundamentals with a long class name that wraps on a phone', starts: 18 * 3_600_000, capacity: 12, places: 3, cancelBefore: 17 * 3_600_000 },
  { id: id(11), name: 'Early class', starts: 2 * 3_600_000 + 1, capacity: 10, places: 0, cancelBefore: -day },
  { id: id(12), name: 'Open training', starts: day + 19 * 3_600_000, capacity: null, places: null, cancelBefore: day + 18 * 3_600_000 },
];
const members = () => role === 'payer' ? [{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent-Longname' }] : [{ id: child, name: 'Casey Parent-Longname' }];
const view = (row: { id: string; memberId: string; sessionId: string; status: 'booked' | 'waitlisted' }) => ({ ...row, createdAt: at(-day),
  waitlistPosition: row.status === 'waitlisted' ? 4 : null, queueRank: row.status === 'waitlisted' ? 2 : null, cancelledAt: null });
const schedule = () => sessions.map(session => ({ id: session.id, name: session.name, startsAt: at(session.starts), endsAt: at(session.starts + 3_600_000),
  coachId: null, capacity: session.capacity, status: 'scheduled', revision: 1, bookingOpensAt: at(-7 * day), cancelBefore: at(session.cancelBefore),
  placesLeft: session.places, bookings: [...bookings.values()].filter(row => row.sessionId === session.id && members().some(member => member.id === row.memberId)).map(view) }));
let code: string | null = null, revision = 3;
const progress = { history: [{ id: id(30), memberId: child, programId: program, rankId: first, rankSystemId: id(9), subRank: 1, promotedAt: at(-30 * day) }],
  programs: [{ id: program, name: 'Fundamentals program', current: { rankId: first, subRank: 1 }, next: { rankId: second, subRank: 0 } }],
  ranks: [{ id: first, name: 'First rank', color: '#f5f5f5', subRanks: [{ id: 'one', name: 'One stripe' }] }, { id: second, name: 'Second rank', color: '#1d4ed8', subRanks: [] }],
  criteria: [{ programId: program, rankId: second, criterionId: 'classes-since-promotion', labelKey: 'ranks/ranks:classes', current: 14, required: 30, eligible: false },
    { programId: program, rankId: second, criterionId: 'time-at-rank', labelKey: 'ranks/ranks:days', current: 30, required: 90, eligible: false }] };
const json = async (req: AsyncIterable<Buffer>) => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) as Record<string, unknown> : {}; };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    const send = (data: unknown) => res.end(JSON.stringify(data));
    if (path === '/api/demo') return send({ data: { mode: 'disabled' } });
    if (path === '/api/auth/bootstrap') return send({ data: bootstrap });
    if (path === '/api/portal/households') return send({ data: { current: household, households: [{ householdId: household, name: 'Parent household', role }] } });
    if (path === '/api/portal/context') return send({ data: role === 'payer' ? { role, householdId: household, memberId: parent } : { role, householdId: household, memberId: child } });
    if (path === '/api/portal/schedule/members') return send({ data: members() });
    if (path === '/api/portal/schedule') { const data = schedule(); return send({ data, pagination: { limit: 100, offset: 0, total: data.length } }); }
    const booking = /^\/api\/portal\/(?:members\/([^/]+)\/)?bookings(?:\/([^/]+)\/cancel)?$/.exec(path);
    if (booking && req.method === 'POST') {
      const memberId = booking[1] ?? child, body = await json(req);
      if (booking[2]) { const row = [...bookings.values()].find(item => item.id === booking[2])!; bookings.delete(row.id); return send({ data: { ...view(row), status: 'cancelled', waitlistPosition: null, queueRank: null, cancelledAt: new Date().toISOString() } }); }
      const session = sessions.find(item => item.id === body.sessionId)!;
      const row = { id: id(40 + bookings.size), memberId, sessionId: session.id, status: session.places === 0 ? 'waitlisted' as const : 'booked' as const };
      bookings.set(row.id, row); return send({ data: view(row) });
    }
    if (path.endsWith('/checkin-code')) {
      if (req.method === 'POST') { await json(req); revision++; code = 'pgci1_' + String(revision).repeat(43).slice(0, 43); }
      return send({ data: { memberId: url.pathname.split('/')[4], code, version: revision, revision } });
    }
    if (path.endsWith('/progress')) return send({ data: path.includes(child) ? progress : { history: [], programs: [], ranks: [], criteria: [] } });
    if (path.endsWith('/attendance')) {
      const visits = Array.from({ length: 25 }, (_, n) => ({ id: id(100 + n), memberId: child, sessionId: null, programId: n % 3 ? program : null, occurredAt: at(-(n + 1) * day), source: 'kiosk', kind: n % 4 ? 'class' : 'open_mat' }));
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
      return send({ data: visits.slice(offset, offset + limit), pagination: { limit, offset, total: visits.length } });
    }
    res.statusCode = 404; return send({ error: { code: 'not_found' } });
  }
  if (path.startsWith('/assets/')) { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(resolve(dist, 'assets', path.split('/').at(-1)!))); return; }
  if (path.startsWith('/portal/sw.js') || path.startsWith('/portal/manifest')) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(dist, 'index.html')));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
const profile = await mkdtemp(resolve(output, 'profile-'));
if (!profile.startsWith(output + sep)) throw new Error('Unexpected profile directory');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launchPersistentContext(profile, { channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge', headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button,input,select,a')].filter(element => !element.classList.contains('sr-only') && element.getClientRects().length && element.getBoundingClientRect().height < 44).map(element => element.textContent)), name).toEqual([]);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations, name).toEqual([]);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
    };
    role = 'payer'; bookings.clear(); bookings.set('locked', { id: id(20), memberId: parent, sessionId: id(11), status: 'booked' }); code = null;
    await page.goto(origin + '/portal/schedule');
    await expect(page.getByRole('heading', { name: 'Class schedule' })).toBeVisible();
    await expect(page.getByText(/cancellation cutoff has passed/)).toBeVisible();
    await page.getByLabel('Booking for').selectOption(child);
    await page.getByRole('button', { name: /^Book Fundamentals with a long class name/ }).click();
    await expect(page.getByText('Casey Parent-Longname is booked.')).toBeVisible();
    await page.getByRole('button', { name: /^Join the waitlist: Early class for Casey/ }).click();
    await expect(page.getByText(/on the waitlist at position 2/)).toBeVisible();
    await check('schedule-payer');
    await page.getByRole('button', { name: /^Cancel booking: Fundamentals with a long class name/ }).click();
    await expect(page.getByText(/place for Casey Parent-Longname is cancelled/)).toBeVisible();
    await page.goto(origin + '/portal/checkin');
    await expect(page.getByText(/no active check-in code/)).toBeVisible();
    await check('checkin-empty');
    await page.getByRole('button', { name: 'Create a code' }).click();
    await expect(page.getByRole('img', { name: /QR check-in code/ })).toBeVisible();
    await page.getByRole('button', { name: 'Replace this code' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await check('checkin-confirm');
    await page.getByRole('button', { name: 'Replace code' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await check('checkin-code');
    await page.goto(origin + '/portal/progress');
    await page.getByLabel('Progress for').selectOption(child);
    await expect(page.getByText('Next: Second rank')).toBeVisible();
    await expect(page.getByText('Current: First rank, One stripe')).toBeVisible();
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.getByRole('button', { name: 'Show more' })).toBeHidden();
    await check('progress');
    role = 'member';
    await page.goto(origin + '/portal/schedule');
    await expect(page.getByRole('heading', { name: 'Class schedule' })).toBeVisible();
    await expect(page.getByLabel('Booking for')).toHaveCount(0);
    if (width === 360) { await page.getByRole('button', { name: 'Menu' }).click(); await expect(page.getByRole('link', { name: 'Check-in code' })).toBeVisible(); }
    await check('schedule-member');
  }
  if (errors.length) throw new Error('Page errors: ' + errors.join('; '));
  console.log('Portal schedule, check-in and progress browser checks passed; screenshots in ' + output);
} finally {
  await browser.close(); server.close();
  await rm(profile, { recursive: true, force: true });
}
