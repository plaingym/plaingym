// SPDX-License-Identifier: AGPL-3.0-only
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test as base, type BrowserContext } from '@playwright/test';

export const gymOrigin = 'https://gym.localhost';
export const missingId = '019a0000-0000-7000-8000-000000000000';
export const password = 'qa-password-for-local-tests';
export type Role = 'owner' | 'admin' | 'coach' | 'front_desk';
export interface RecordId { id: string; revision: number }
export interface Person extends RecordId { firstName: string; lastName: string; householdId: string }
export interface Program extends RecordId { name: string; rankSystemId: string }
export interface Rank extends RecordId { name: string; position: number }
export interface Sandbox { gymId: string; origin: string; kioskToken: string }
export interface Operation {
  permission: { kind: string; capability?: string };
  additionalPermissions?: { kind: string; capability?: string }[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: unknown;
}
export interface Document { paths: Record<string, Record<string, Operation>> }

/** Route every local test hostname to loopback while preserving Host, Origin,
 * TLS SNI and cookies. Node does not resolve wildcard .localhost like Chromium. */
export class Client {
  cookie = '';
  constructor(readonly origin: string, readonly headers: Record<string, string> = {}) {}
  async request<T>(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const url = new URL(path, this.origin);
    const payload = Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; body: T; text: string; cookies: string[] }>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: 443, servername: url.hostname,
        rejectUnauthorized: false, path: url.pathname + url.search, method,
        headers: { host: url.host, origin: this.origin, ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...this.headers, ...extra }, timeout: 75_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: T;
          try { body = JSON.parse(text) as T; } catch { body = text as T; }
          resolve({ status: res.statusCode!, body, text, cookies: res.headers['set-cookie'] ?? [] });
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
async function cached<T>(name: string, create: () => Promise<T>): Promise<T> {
  const file = new URL('./coverage/fixtures.json', import.meta.url);
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (name in values) return values[name] as T;
  const value = await create();
  await writeFile(file, JSON.stringify({ ...values, [name]: value }), { mode: 0o600 });
  return value;
}

export const test = base.extend<object, { install: Install; sandboxes: Sandbox[] }>({
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
      const first = await entry.json<{ data: Sandbox }>('/api/demo/sandboxes', 'POST', {});
      const second = await entry.json<{ data: Sandbox }>('/api/demo/sandboxes', 'POST', {});
      return [first.data, second.data];
    }));
  }, { scope: 'worker', timeout: 120_000 }],
});
export { expect };

export async function demoClient(sandbox: Sandbox, role: 'owner' | 'coach' | 'student') {
  const client = new Client(sandbox.origin);
  client.cookie = await cached(`login:${sandbox.gymId}:${role}`, async () => {
    const response = await client.request('/api/demo/login', 'POST', { role });
    expect(response.status, response.text).toBe(200);
    return response.cookies.map((value) => value.split(';')[0]).join('; ');
  });
  return client;
}
