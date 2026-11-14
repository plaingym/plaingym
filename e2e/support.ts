// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { expect, test as base, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { classStart, localDate, mondayOf, type ClassStartOptions } from './dates.js';

export const gymOrigin = 'https://gym.localhost';
/** The stack's one published address; another loopback lets a run sit beside a local proxy on 127.0.0.1:443. */
export const loopback = process.env.E2E_LOOPBACK ?? '127.0.0.1';
let caddyCa: Buffer | undefined;
/** The run's self-signed proxy certificate, exported by run.mjs: API requests verify TLS against it. */
export function localCa() {
  const file = process.env.E2E_CA_FILE;
  if (!file) throw new Error('E2E_CA_FILE is not set; run the specs with e2e/run.mjs');
  return caddyCa ??= readFileSync(file);
}
export const missingId = '019a0000-0000-7000-8000-000000000000';
export const password = 'qa-password-for-local-tests';
export type Role = 'owner' | 'admin' | 'coach' | 'front_desk';
export interface RecordId { id: string; revision: number }
export interface Person extends RecordId { firstName: string; lastName: string; householdId: string }
export interface Program extends RecordId { name: string; rankSystemId: string }
export interface Rank extends RecordId { name: string; position: number }
export interface Sandbox { gymId: string; origin: string; kioskToken: string }
export interface Operation {
  permission: { kind: string; capability?: string; purpose?: string };
  additionalPermissions?: { kind: string; capability?: string }[];
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
}
export interface Schema {
  type?: string; format?: string; enum?: unknown[]; pattern?: string; minLength?: number; minimum?: number; exclusiveMinimum?: boolean | number;
  properties?: Record<string, Schema>; required?: string[]; items?: Schema; minItems?: number; anyOf?: Schema[]; oneOf?: Schema[]; nullable?: boolean;
}
export interface Document { paths: Record<string, Record<string, Operation>> }

/** One reserved block for the main process, then one for each worker (including replacement workers). */
export function addressAllocator(workerIndex?: string) {
  const block = workerIndex === undefined ? 0 : Number(workerIndex) + 1;
  let clients = 0;
  // Checked on use, not at import: a run with many failures starts many workers, and specs without a client must still report their own result.
  return () => {
    if (!Number.isInteger(block) || block < 0 || block >= 32 || (workerIndex !== undefined && Number(workerIndex) < 0)) {
      throw new Error('No client address block available for worker ' + workerIndex);
    }
    if (clients >= 4096) throw new Error('Client address block exhausted');
    const index = block * 4096 + clients++;
    return `198.${18 + (index >> 16)}.${(index >> 8) & 255}.${index & 255}`;
  };
}
/**
 * The next client address, from 198.18.0.0/15 (set aside for network tests): 4,096 for each Playwright worker, so a
 * worker that replaces a failed one starts with fresh ones. The stack's Caddy passes it on as the request's client
 * address (Caddyfile), so each client meets the production per-address limits on its own, as a separate visitor would.
 */
export const clientAddress = addressAllocator(process.env.TEST_WORKER_INDEX);

/** Route every local test hostname to loopback while preserving Host, Origin,
 * TLS SNI and cookies. Node does not resolve wildcard .localhost like Chromium. Each client has its own address. */
export class Client {
  cookie = '';
  readonly address = clientAddress();
  constructor(readonly origin: string, readonly headers: Record<string, string> = {}) {}
  async request<T>(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const url = new URL(path, this.origin);
    const payload = Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; body: T; text: string; cookies: string[]; location?: string; retryAfter?: number }>((resolve, reject) => {
      const req = httpsRequest({ hostname: loopback, port: 443, servername: url.hostname,
        ca: localCa(), path: url.pathname + url.search, method,
        headers: { host: url.host, origin: this.origin, 'x-forwarded-for': this.address, ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...this.headers, ...extra }, timeout: 75_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: T;
          try { body = JSON.parse(text) as T; } catch { body = text as T; }
          const retry = Number(res.headers['retry-after'] ?? NaN);
          resolve({ status: res.statusCode!, body, text, cookies: res.headers['set-cookie'] ?? [], location: res.headers.location,
            ...(Number.isFinite(retry) ? { retryAfter: retry } : {}) });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
      req.end(payload);
    });
  }
  async json<T>(path: string, method = 'GET', body?: unknown, extra?: Record<string, string>) {
    const response = await this.request<T>(path, method, body, extra);
    expect(response.status, `${method} ${path}: ${response.text}`).toBeGreaterThanOrEqual(200);
    expect(response.status, `${method} ${path}: ${response.text}`).toBeLessThan(300);
    return response.body;
  }
  async login(email: string) {
    const response = await this.request('/api/auth/sign-in/email', 'POST', { email, password });
    expect(response.status, response.text).toBe(200);
    this.cookie = response.cookies.map((value) => value.split(';')[0]).join('; ');
    expect(this.cookie).toContain('session_token=');
  }
  async browser(context: BrowserContext) {
    await context.addCookies(this.cookie.split('; ').filter(Boolean).map((pair) => {
      const separator = pair.indexOf('=');
      return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: this.origin, secure: true, httpOnly: true, sameSite: 'Lax' as const };
    }));
  }
}

export interface Install {
  clients: Record<Role, Client>;
  device: Client;
  token: string;
  program: Program;
  ranks: Rank[];
  document: Document;
}

async function initialize(): Promise<Install> {
  const guest = new Client(gymOrigin), owner = new Client(gymOrigin);
  const token = process.env.E2E_SETUP_TOKEN;
  if (!token) throw new Error('Run through pnpm --dir e2e test to create an isolated install');
  const setupStatus = await guest.request('/api/setup');
  if (setupStatus.status === 200) {
    expect((await guest.request('/api/setup/start', 'POST', { choice: 'fresh' })).status).toBe(403);
    const setup = new Client(gymOrigin, { 'x-setup-token': token });
    await setup.json('/api/setup/start', 'POST', { choice: 'fresh' });
    await setup.json('/api/setup/owner', 'POST', { name: 'QA Owner', email: 'owner@example.invalid', password });
    await owner.login('owner@example.invalid');
    const revision = async () => (await owner.json<{ data: { revision: number } }>('/api/setup')).data.revision;
    await owner.json('/api/setup/gym', 'PUT', { name: 'QA academy', timezone: 'UTC', currency: 'USD', address: {},
      branding: { logoKey: null, primaryColor: null }, revision: await revision() });
    await owner.json('/api/setup/packs', 'POST', { packs: [{ packId: 'bjj', version: 1 }], revision: await revision() });
    await owner.json('/api/setup/website', 'PUT', { websiteEnabled: false, existingSiteUrl: null, revision: await revision() });
    await owner.json('/api/setup/smtp', 'PUT', { choice: 'skip', revision: await revision() });
    await owner.json('/api/setup/stripe', 'PUT', { choice: 'skip', revision: await revision() });
    await owner.json('/api/setup/finish', 'POST', { choice: 'fresh', skipBackups: true, revision: await revision() });
  } else {
    expect(setupStatus.status).toBe(404);
    // The prerequisite browser project completes setup using these same test credentials.
    await owner.login('owner@example.invalid');
  }
  const clients = { owner } as Record<Role, Client>;
  for (const role of ['admin', 'coach', 'front_desk'] as const) {
    const email = `${role}@example.invalid`;
    const invite = await owner.json<{ data: { invitationUrl: string } }>('/api/staff/invitations', 'POST', { email, role, delivery: 'print' });
    await guest.json('/api/staff/invitations/accept', 'POST', { token: new URL(invite.data.invitationUrl).hash.slice(1), name: role, password });
    clients[role] = new Client(gymOrigin);
    await clients[role].login(email);
  }
  const registration = await owner.json<{ data: { token: string } }>('/api/kiosk/devices', 'POST', { name: 'QA tablet' });
  const program = (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data.find((p) => p.rankSystemId)!;
  const ranks = (await owner.json<{ data: Rank[] }>('/api/ranks?rankSystemId=' + program.rankSystemId)).data.sort((a, b) => a.position - b.position);
  const document = await owner.json<Document>('/api/openapi.json');
  return { clients, device: new Client(gymOrigin, { authorization: 'Bearer ' + registration.data.token }),
    token: registration.data.token, program, ranks, document };
}

// A failed test starts a fresh worker. Reuse this run's fixtures instead of
// consuming the sandbox creation quota or trying to initialize the install twice.
export async function cached<T>(name: string, create: () => Promise<T>): Promise<T> {
  const values = await readFixtures();
  if (name in values) return values[name] as T;
  const value = await create();
  // Read again: a composite fixture saves its own writes while create() runs. The rename means a worker that dies mid-save can't truncate the file.
  await writeFixtures({ ...await readFixtures(), [name]: value });
  return value;
}
const fixturesFile = new URL('./coverage/fixtures.json', import.meta.url);
/** Clear composite checkpoints while retaining the successfully checked writes inside them. */
export async function clearCheckpoints(names: string[]) {
  const values = await readFixtures();
  for (const name of names) delete values[name];
  await writeFixtures(values);
}
async function writeFixtures(values: Record<string, unknown>) {
  const temporary = new URL(`./coverage/fixtures-${randomUUID()}.tmp`, import.meta.url);
  await writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
  await rename(temporary, fixturesFile);
}
async function readFixtures(): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(fixturesFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {};
}

/** Chromium's console line for a blocked (or, report-only, reported) resource or inline code names the policy. */
const cspViolation = /Content Security Policy/i;

/** A URL or console line without what can carry a credential: signed-link tokens, queries and fragments. */
const redacted = (text: string) => text.replace(/\/l\/[A-Za-z0-9_-]{8,}/g, '/l/:token').replace(/[?#][^\s'"]*/g, '');
interface CspGuard { readonly violations: string[]; watch(context: BrowserContext): void }

/** Also used by specs that launch their own browser, such as the VM wizard. */
export function createCspGuard(): CspGuard {
  const violations: string[] = [], watched = new WeakSet<BrowserContext>();
  return { violations, watch(target) {
    if (watched.has(target)) return;
    watched.add(target);
    target.on('console', (message) => {
      if (!cspViolation.test(message.text())) return;
      const url = message.page()?.url() ?? message.location().url;
      violations.push(redacted(`${url}: ${message.text()}`));
    });
  } };
}

export const test = base.extend<{ cspGuard: CspGuard; cspViolations: string[] }, { install: Install; sandboxes: Sandbox[] }>({
  /**
   * Fails any test whose pages log a Content-Security-Policy violation: the pages of the default context, when the test
   * uses it, and of every context the test opens itself (`browser.newContext`, `browser.newPage`), each frame included.
   */
  cspGuard: [async ({ browser }, use) => {
    const { violations, watch } = createCspGuard();
    const newContext = browser.newContext;
    browser.newContext = async (...options) => { const created = await newContext.apply(browser, options); watch(created); return created; };
    try { await use({ violations, watch }); } finally { browser.newContext = newContext; }
    expect(violations, 'Content-Security-Policy violations in the browser console').toEqual([]);
  }, { auto: true }],
  context: async ({ context, cspGuard }, use) => { cspGuard.watch(context); await use(context); },
  /** The violations so far, for a test that expects some: it empties the list once it has checked them. */
  cspViolations: async ({ cspGuard }, use) => { await use(cspGuard.violations); },
  install: [async ({ browserName: _browserName }, use) => {
    const install = await cached('install', initialize);
    const restore = (client: Client) => Object.assign(new Client(client.origin, client.headers), { cookie: client.cookie });
    for (const role of Object.keys(install.clients) as Role[]) install.clients[role] = restore(install.clients[role]);
    install.device = restore(install.device);
    await use(install);
  }, { scope: 'worker', timeout: 90_000 }],
  sandboxes: [async ({ browserName: _browserName }, use) => {
    await use(await cached('sandboxes', async () => {
      const entry = new Client('https://demo.localhost');
      async function copy() {
        let result = await entry.json<{ data: Sandbox | { pending: true; ticket: string; position: number } }>('/api/demo/sandboxes', 'POST', {});
        const deadline = Date.now() + 90_000;
        while ('pending' in result.data) {
          if (Date.now() >= deadline) throw new Error('Demo copy preparation timed out');
          await new Promise(resolve => setTimeout(resolve, 1000));
          result = await entry.json('/api/demo/creations/' + result.data.ticket);
        }
        return result.data;
      }
      return [await copy(), await copy()];
    }));
  }, { scope: 'worker', timeout: 120_000 }],
});
export { expect };

// The date helpers (tested in dates.test.ts). The server has no test clock, so specs derive the day and week they read
// back from the class they created, and place a class away from local midnight, instead of assuming when they run.
export { addDays, classStart, localDate, mondayOf, wall, weekStartOf, weekday, type ClassStartOptions } from './dates.js';

/** The gym's IANA timezone, read by a signed-in owner. */
export async function gymTimezone(owner: Client) {
  return (await owner.json<{ data: { timezone: string } }>('/api/settings')).data.timezone;
}

/** Shows the admin schedule's week that holds an instant. The page opens on the gym zone's current week, which a class on the
 * other side of a Sunday midnight in that zone misses; and the week field moves to the Monday that starts the week. */
export async function showWeek(page: Page, timeZone: string, instant: Date | number) {
  const weekOf = page.getByLabel('Week of', { exact: true }), date = localDate(instant, timeZone);
  await weekOf.fill(date);
  await expect(weekOf).toHaveValue(mondayOf(date));
}

export interface ClassSession extends RecordId { name: string; startsAt: string; endsAt: string }
/** A one-off class for the selected program (or the first), five places, that starts on a 5-minute mark at least `leadMinutes` from now (default 26 hours,
 * inside every week of the portal's schedule and far from any booking cutoff), clear of the gym's local midnight. */
export async function createClass(owner: Client, name: string, options: ClassStartOptions & { capacity?: number; programId?: string } = {}): Promise<ClassSession> {
  const { capacity = 5, durationMinutes = 60, leadMinutes = 26 * 60, programId, ...timing } = options;
  const selectedProgram = programId ?? (await owner.json<{ data: Program[] }>('/api/programs?limit=100')).data[0]!.id;
  const startsAt = classStart(Date.now(), await gymTimezone(owner), { ...timing, leadMinutes, durationMinutes });
  return (await owner.json<{ data: ClassSession }>('/api/schedule/sessions', 'POST', { name, startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + durationMinutes * 60_000).toISOString(), coachId: null, capacity, notes: null, kind: 'class', programIds: [selectedProgram], tagIds: [] })).data;
}

/** A near-future class may fall in the next Monday-based calendar week. */
export async function showPortalClass(page: Page, target: Locator) {
  const loading = page.getByText('Loading classes…', { exact: true });
  await expect(page.getByRole('heading', { name: 'Class schedule', exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  if (!await target.isVisible()) {
    await page.getByRole('button', { name: 'Next week', exact: true }).click();
    await expect(loading).toHaveCount(0);
  }
  await expect(target).toBeVisible();
}

export async function demoClient(sandbox: Sandbox, role: 'owner' | 'coach' | 'student') {
  const client = new Client(sandbox.origin);
  client.cookie = await cached(`login:${sandbox.gymId}:${role}`, async () => {
    const response = await client.request('/api/demo/login', 'POST', { role });
    expect(response.status, response.text).toBe(200);
    return response.cookies.map((value) => value.split(';')[0]).join('; ');
  });
  return client;
}
