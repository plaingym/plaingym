// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { households, householdUsers, staffRoles, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { createDemoService } from './service.js';
import type { DemoConfig } from './config.js';
import { createDemoIdentities, demoEmail } from './identities.js';
import { createDemoRoutes, joinTestCardHint, routes as disabledRoutes } from './demo.routes.js';
import { joinStatusPage, type JoinPageState } from '../public/pages/join.page.js';
import { createOutboxQuery } from './outbox.js';
import { runSeeds } from './seed/index.js';
import { foundationSeed } from './seed/foundation.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { OutboxEmail } from '../infra/email/outbox.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { createAuthService } from '../infra/auth/service.js';
import { authConfig } from '../infra/auth/config.js';
import { authorize } from '../areas/staff/auth.permissions.js';
import { TestClock } from '../core/clock.js';
import { createServerRegistry, type RouteRegistration } from '../core/registry.js';
import type { RequestEnvironment } from '../core/context.js';
import { errorHandler } from '../core/errors.js';
import { csrf } from '../core/csrf.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { renderDemoLogin } from '../emails/demo/demo.js';

const db = useTestDatabase();
const key = parseEncryptionKey('cd'.repeat(32));
const config: DemoConfig = { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 };
const authentication = authConfig({ AUTH_SECRET: 'demo-sign-in-test-secret-with-32-characters', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'production' }, true);
const accounts = () => createAccountService(authentication, () => db.system.db);
const authFactory: typeof createAuthService = (options) => createAuthService({ ...options, database: () => db.system.db });
const clock = new TestClock('2026-11-04T12:00:00Z');
function fixture(settings: Partial<DemoConfig> = {}) {
  const mode = { ...config, ...settings };
  const deletion = createGymDeleteService({ clock, scope: db.forGym, system: db.forSystem, removeUploads: async () => {} });
  const identities = createDemoIdentities({ config: mode, authConfig: authentication, clock, accounts: accounts(), scope: db.forGym, authFactory });
  const seed = (context: Parameters<typeof runSeeds>[0]) => runSeeds(context, [foundationSeed({ scope: db.forGym, clock })]);
  return { service: createDemoService({ config: mode, key, clock, scope: db.forGym, system: db.forSystem, identities, seed, deletion }), identities };
}
let address = 10;
/** The registered demo routes for one sandbox host, each app with its own client address so rate limits stay per test. */
function appFor(routes: readonly RouteRegistration[], gymId: string, enabledModules: readonly string[] = []) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set(enabledModules) }, principal: { kind: 'anonymous' }, clock, requestId: 'demo-sign-in' });
    await next();
  });
  app.onError(errorHandler); app.use('*', csrf('https://demo.example.test'));
  createServerRegistry({ routes }).mount(app, authorize, new Set());
  return app;
}
const routesFor = (f: ReturnType<typeof fixture>) => {
  const ip = `192.0.2.${address++}`;
  return createDemoRoutes(f.service, { installOrigin: 'https://demo.example.test', outbox: createOutboxQuery(db.forGym), scope: db.forGym,
    clientIp: { peerAddress: () => ip } });
};
const send = (app: OpenAPIHono<RequestEnvironment>, path: string, body?: unknown) => app.request(path, body === undefined
  ? { headers: { host: 'demo.example.test' } }
  : { method: 'POST', headers: { host: 'demo.example.test', 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A household that joined through `/join`, with its payer login, as the join flow leaves them. */
async function joined(gymId: string, name: string, at: Date) {
  const householdId = uuidv7(at.getTime()), email = `${name.toLowerCase().replaceAll(' ', '.')}.${householdId.slice(-6)}@example.invalid`;
  const user = await accounts().provisionUser(gymId, email, name, clock, async (tx, userId) => {
    await tx.insert(households).values({ id: householdId, gymId, name, email, createdAt: at });
    await tx.insert(householdUsers).values({ gymId, userId, householdId, scope: 'payer', createdAt: at });
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'public.join.admitted', targetType: 'household', targetId: householdId, occurredAt: at });
  });
  const [login] = await db.forGym(gymId, (tx) => tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.householdId, householdId)));
  return { id: login!.id, userId: user.id, householdId, email, name };
}
/** A sign-in message captured as the demo runtime captures every magic link, to the address the auth service lowercased. */
async function signInMessage(gymId: string, to: string, token: string) {
  const url = `https://sandbox.demo.example.test/api/auth/magic-link/verify?token=${token}&callbackURL=https%3A%2F%2Fsandbox.demo.example.test%2Flogin`;
  await new OutboxEmail(gymId, clock, db.forGym).sendEmail({ to: to.toLowerCase(), ...await renderDemoLogin(url, createTranslator(locales.en ?? {})) });
  // Each message a second after the last, as real sends are.
  clock.advance(1000);
}
const sessionUser = async (gymId: string, response: Response) => {
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const auth = authFactory({ config: authentication, sendMagicLink: async () => {} });
  return auth.bind({ gymId, origin: 'https://sandbox.demo.example.test', clientIp: '192.0.2.1' })
    .getSession(new Request('https://sandbox.demo.example.test/api/auth/get-session', { headers: { cookie } }));
};

let f: ReturnType<typeof fixture>, a: { gymId: string }, b: { gymId: string };
beforeAll(async () => { f = fixture(); a = await f.service.create(); b = await f.service.create(); });

describe('signing in again as a member who joined', () => {
  it('lists the latest five joined members by name and signs one in to the portal', async () => {
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await joined(a.gymId, `Riley Joined ${i}`, new Date(Date.parse('2026-11-04T10:00:00Z') + i * 60_000)));
    const app = appFor(routesFor(f), a.gymId), menu = await send(app, '/api/demo/menu');
    expect(menu.status).toBe(200);
    expect(menu.headers.get('cache-control')).toBe('no-store');
    expect(await menu.json()).toEqual({ data: { website: false, members: people.slice(1).reverse().map(({ id, name }) => ({ id, name })) } });
    const latest = people[5]!, response = await send(app, '/api/demo/login', { member: latest.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { redirect: '/portal' } });
    expect(await sessionUser(a.gymId, response)).toEqual({ userId: latest.userId });
    // The oldest join is no longer offered, so it doesn't sign in either.
    expect((await send(app, '/api/demo/login', { member: people[0]!.id })).status).toBe(404);
  });
  it('says whether the website is on, for the menu link', async () => {
    const menu = await send(appFor(routesFor(f), a.gymId, ['website']), '/api/demo/menu');
    expect((await menu.json() as { data: { website: boolean } }).data.website).toBe(true);
  });
  it('refuses another sandbox’s member with 404 and lists only this sandbox’s', async () => {
    const theirs = await joined(b.gymId, 'Other Sandbox', new Date('2026-11-04T11:00:00Z'));
    const app = appFor(routesFor(f), a.gymId);
    expect((await send(app, '/api/demo/login', { member: theirs.id })).status).toBe(404);
    expect(JSON.stringify(await (await send(app, '/api/demo/menu')).json())).not.toContain(theirs.id);
    await expect(f.service.login(a.gymId, { member: theirs.id }, '192.0.2.200')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses staff identities and logins that did not join', async () => {
    const coach = await joined(a.gymId, 'Coach Who Joined', new Date('2026-11-04T11:30:00Z'));
    await db.forGym(a.gymId, (tx) => tx.insert(staffRoles).values({ gymId: a.gymId, userId: coach.userId, role: 'coach', createdAt: clock.now() }));
    const student = await accounts().findUserByEmail(demoEmail(a.gymId, 'student'));
    const [seeded] = await db.forGym(a.gymId, (tx) => tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, student!.id)));
    const app = appFor(routesFor(f), a.gymId), listed = JSON.stringify(await (await send(app, '/api/demo/menu')).json());
    for (const id of [coach.id, seeded!.id]) {
      expect(listed).not.toContain(id);
      expect((await send(app, '/api/demo/login', { member: id })).status).toBe(404);
    }
    // A staff role's user ID or an address isn't a member login either.
    for (const body of [{ member: coach.userId }, { member: coach.id, role: 'owner' }, { email: coach.email }])
      expect((await send(app, '/api/demo/login', body)).status).toBe(body.member === coach.userId ? 404 : 400);
  });
  it('signs in nobody when the household’s address no longer names its payer login', async () => {
    const moved = await joined(a.gymId, 'Moved Address', new Date('2026-11-04T11:45:00Z'));
    await db.forGym(a.gymId, (tx) => tx.update(households).set({ email: demoEmail(a.gymId, 'owner') }).where(eq(households.id, moved.householdId)));
    expect((await send(appFor(routesFor(f), a.gymId), '/api/demo/login', { member: moved.id })).status).toBe(404);
  });
  it('refuses the member login and the menu outside demo mode', async () => {
    const someone = await joined(a.gymId, 'Outside Demo', new Date('2026-11-04T11:50:00Z'));
    const app = appFor(disabledRoutes, a.gymId);
    expect((await send(app, '/api/demo/login', { member: someone.id })).status).toBe(404);
    expect((await send(app, '/api/demo/menu')).status).toBe(404);
    const off = fixture({ enabled: false });
    await expect(off.identities.login(a.gymId, { member: someone.id }, 'https://sandbox.demo.example.test', '192.0.2.201')).rejects.toMatchObject({ code: 'not_found' });
    // An ordinary gym in demo mode isn't a sandbox.
    expect((await send(appFor(routesFor(f), uuidv7()), '/api/demo/menu')).status).toBe(404);
  });
});

describe('the visitor’s own sign-in link', () => {
  it('opens the latest sign-in message to the entered address, and only sign-in messages', async () => {
    const visitor = 'Visitor.Link@example.invalid', outbox = new OutboxEmail(a.gymId, clock, db.forGym);
    await signInMessage(a.gymId, visitor, 'older');
    await signInMessage(a.gymId, visitor, 'latest');
    await signInMessage(a.gymId, 'someone.else@example.invalid', 'theirs');
    // Later, but not a sign-in message: an invitation carrying a sign-in-shaped link is still the owner's to read.
    clock.advance(1000);
    await outbox.sendEmail({ to: visitor.toLowerCase(), subject: 'Your staff invitation', html: '<p>x</p>',
      text: 'Accept\nhttps://sandbox.demo.example.test/api/auth/magic-link/verify?token=invitation' });
    const app = appFor(routesFor(f), a.gymId), response = await send(app, '/api/demo/sign-in-link', { email: ' ' + visitor + ' ' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: { href: '/api/auth/magic-link/verify?token=latest&callbackURL=https%3A%2F%2Fsandbox.demo.example.test%2Flogin' } });
    expect((await send(app, '/api/demo/sign-in-link', { email: 'nobody@example.invalid' })).status).toBe(404);
  });
  it('never reads another sandbox’s messages', async () => {
    await signInMessage(b.gymId, 'only.b@example.invalid', 'other-sandbox');
    expect((await send(appFor(routesFor(f), a.gymId), '/api/demo/sign-in-link', { email: 'only.b@example.invalid' })).status).toBe(404);
    expect((await (await send(appFor(routesFor(f), b.gymId), '/api/demo/sign-in-link', { email: 'only.b@example.invalid' })).json() as { data: { href: string } }).data.href)
      .toContain('token=other-sandbox');
  });
  it('is refused outside demo mode and outside a sandbox', async () => {
    await signInMessage(a.gymId, 'refused@example.invalid', 'refused');
    expect((await send(appFor(disabledRoutes, a.gymId), '/api/demo/sign-in-link', { email: 'refused@example.invalid' })).status).toBe(404);
    expect((await send(appFor(routesFor(f), uuidv7()), '/api/demo/sign-in-link', { email: 'refused@example.invalid' })).status).toBe(404);
    expect((await send(appFor(routesFor(f), a.gymId), '/api/demo/sign-in-link', { email: 'refused@example.invalid', gymId: b.gymId })).status).toBe(400);
  });
});

describe('the test card on the join page', () => {
  const t = createTranslator(locales.en ?? {}), gym = { name: 'Demo academy', revision: 1, logoKey: null, primaryColor: null };
  const hint = 'Demo payment: use the test card 4242 4242 4242 4242, any future expiry date and any CVC. No real money moves.';
  it('shares a short per-gym readiness cache, refreshes it and retries a failed read without failing the page', async () => {
    const time = new TestClock('2026-11-01T12:00:00Z');
    const status = vi.fn(async () => ({ join: true, expiresAt: '2026-11-02T12:00:00Z' }));
    const read = joinTestCardHint({ status }, t, time);
    expect(await Promise.all([read(a.gymId), read(a.gymId)])).toEqual([hint, hint]);
    expect(status).toHaveBeenCalledTimes(1);
    expect(await read(b.gymId)).toBe(hint);
    expect(status).toHaveBeenCalledTimes(2);
    time.advance(5_000);
    status.mockRejectedValueOnce(new Error('Read failed'));
    expect(await read(a.gymId)).toBeUndefined();
    expect(await read(a.gymId)).toBe(hint);
    expect(status).toHaveBeenCalledTimes(4);
    time.set('2026-11-02T12:00:00Z');
    expect(await read(a.gymId)).toBeUndefined();
  });
  it('names the test card in a sandbox that takes joins, and nowhere else', async () => {
    const paid = fixture({ stripe: { testKey: 'sk_test_demo', webhookSecret: 'whsec_demo' } });
    paid.service.setJoinReadiness({ ready: async () => [] });
    expect(await joinTestCardHint(paid.service, t, clock)(a.gymId)).toBe(hint);
    expect(await joinTestCardHint(f.service, t, clock)(a.gymId)).toBeUndefined();
    expect(await joinTestCardHint(paid.service, t, clock)(uuidv7())).toBeUndefined();
    expect(await joinTestCardHint(fixture({ enabled: false, stripe: { testKey: 'sk_test_demo', webhookSecret: 'whsec_demo' } }).service, t, clock)(a.gymId)).toBeUndefined();
  });
  it.each(['continue', 'cancelled', 'confirming', 'welcomeEmail', 'closed', 'failed'] satisfies JoinPageState[])('shows it only on the steps that lead to payment (%s)', async (state) => {
    const page = String(await joinStatusPage({ gym, t, state, testCardHint: hint }));
    expect(page.includes(hint)).toBe(state === 'continue' || state === 'cancelled');
    expect(String(await joinStatusPage({ gym, t, state }))).not.toContain('4242');
  });
});
