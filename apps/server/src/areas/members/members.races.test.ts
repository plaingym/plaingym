// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { households, invoices, members, signedLinks, staffProfiles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createStaffProfileService } from '../staff/profiles.js';
import { createStaffProfileRoutes } from '../staff/profiles.routes.js';
import { createPackSalesService } from '../billing/packs/sales.js';
import { createSignedLinkCheckout } from '../billing/signed-link-checkout.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembersService } from './members.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-10T12:00:00Z');
const queue = () => ({ jobs: new FakeJobs(clock), timezone: 'UTC' });
const context = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id });
  return { gymId, home, person };
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function waitingFor(table: string, strength: string) {
  await expect.poll(async () => {
    const [row] = await db.system.sql`select exists (select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
      and query ilike ${`%${table}%`} and query ilike ${`%${strength}%`}) as waiting`;
    return row!.waiting;
  }, { timeout: 5000 }).toBe(true);
}

it.each(['create', 'update'] as const)('answers 409 when a staff profile %s waits for a member deletion', async kind => {
  const f = await fixture(), owner = await factory('staffRoles', f.gymId, { role: 'owner' });
  const profile = await factory('staffProfiles', f.gymId);
  const held = gate(), release = gate();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    const result = await fn(tx); held.release(); await release.promise; return result;
  });
  const deleting = createMembersService({ scope, clock }).deleteMember(context(f.gymId), f.person.id, 1, queue());
  await held.promise;
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('context', { principal: { kind: 'staff', gymId: f.gymId, userId: owner.userId, roles: ['owner'] },
      gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, requestId: 'profile-delete-race', clock });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createStaffProfileRoutes(createStaffProfileService(db.forGym)) }).mount(app, authorize, new Set());
  const linking = app.request('/api/staff/profiles' + (kind === 'update' ? '/' + profile.id : ''), {
    method: kind === 'update' ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Coach', memberId: f.person.id, ...(kind === 'update' ? { revision: 1 } : {}) }),
  });
  try { await waitingFor('members', 'for share'); } finally { release.release(); }
  await deleting;
  expect((await linking).status).toBe(409);
  expect(await db.forGym(f.gymId, tx => tx.select().from(staffProfiles).where(eq(staffProfiles.memberId, f.person.id)))).toEqual([]);
  const profiles = createStaffProfileService(db.forGym), actor = { gymId: f.gymId, actorUserId: owner.userId, clock };
  const foreign = await fixture();
  for (const memberId of [f.person.id, foreign.person.id])
    await expect(profiles.createProfile(actor, { displayName: 'Missing', memberId })).rejects.toMatchObject({ code: 'not_found' });
});

it('waits for a household-first pack sale without locking its member or deadlocking', async () => {
  const f = await fixture(), pack = await factory('classPacks', f.gymId, { currency: 'USD' });
  const held = gate(), release = gate();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    await tx.select().from(households).where(eq(households.id, f.home.id)).for('share');
    held.release(); await release.promise; return fn(tx);
  });
  const selling = createPackSalesService({ scope, clock, settings: createGymSettingsAccessor({ scope: db.forGym, clock }) })
    .sell(context(f.gymId), pack.id, { memberId: f.person.id, dueOn: '2026-11-10' });
  await held.promise;
  const deleting = createMembersService({ scope: db.forGym, clock }).deleteMember(context(f.gymId), f.person.id, 1, queue())
    .then(result => result, (error: unknown) => error);
  try { await waitingFor('households', 'for update'); } finally { release.release(); }
  expect(await selling).toMatchObject({ status: 'open', householdId: f.home.id });
  expect(await deleting).toMatchObject({ code: 'conflict', details: { reason: ['billing_records'] } });
});

it('rechecks a member household move that commits while deletion waits', async () => {
  const f = await fixture(), destination = await factory('households', f.gymId);
  const held = gate(), release = gate();
  const moving = db.forGym(f.gymId, async tx => {
    await tx.select().from(households).where(eq(households.id, f.home.id)).for('update');
    held.release(); await release.promise;
    await tx.update(members).set({ householdId: destination.id }).where(eq(members.id, f.person.id));
  });
  await held.promise;
  const deleting = createMembersService({ scope: db.forGym, clock }).deleteMember(context(f.gymId), f.person.id, 1, queue())
    .then(result => result, (error: unknown) => error);
  try { await waitingFor('households', 'for update'); } finally { release.release(); }
  await moving;
  expect(await deleting).toMatchObject({ code: 'conflict', message: 'The member changed households while waiting to delete' });
  expect(await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.person.id))))
    .toMatchObject([{ householdId: destination.id }]);
});

it('waits for household-first erasure and refuses its stale member revision without deadlocking', async () => {
  const f = await fixture(), held = gate(), release = gate();
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    await tx.select().from(households).where(eq(households.id, f.home.id)).for('update');
    held.release(); await release.promise; return fn(tx);
  });
  const erasing = createMembersService({ scope, clock }).eraseMember(context(f.gymId), f.person.id, { revision: 1 }, queue());
  await held.promise;
  const deleting = createMembersService({ scope: db.forGym, clock }).deleteMember(context(f.gymId), f.person.id, 1, queue())
    .then(result => result, (error: unknown) => error);
  try { await waitingFor('households', 'for update'); } finally { release.release(); }
  await expect(erasing).resolves.toMatchObject({ householdErased: true });
  expect(await deleting).toMatchObject({ code: 'conflict', message: 'The record changed since it was read.' });
});

it.each([false, true])('erasure locks household links before invoices during Checkout (held: %s)', async needsReview => {
  const f = await fixture(), bill = await factory('invoices', f.gymId, { householdId: f.home.id, status: 'open', number: 1, needsReview });
  const link = await factory('signedLinks', f.gymId, { householdId: f.home.id, invoiceId: bill.id, purpose: 'pay_invoice',
    expiresAt: new Date(clock.now().getTime() + 86_400_000) });
  const held = gate(), release = gate();
  const prepared = new Error('Checkout reservation reached');
  let calls = 0;
  // start reads settings in its first transaction; pause its second after taking Checkout's first lock.
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
    if (++calls === 2) {
      await tx.select().from(signedLinks).where(eq(signedLinks.id, link.id)).for('update');
      held.release(); await release.promise;
      await fn(tx);
      // Stop at the prepared transaction; no customer or provider work is needed to exercise its lock order.
      throw prepared;
    }
    return fn(tx);
  });
  const provider = new FakePayments(f.gymId, clock);
  const checkout = createSignedLinkCheckout({ scope, clock, paymentsFor: async () => provider, originFor: async () => 'https://gym.example.test' })
    .start(f.gymId, link.id).then(result => result, (error: unknown) => error);
  await held.promise;
  const erasing = createMembersService({ scope: db.forGym, clock }).eraseMember(context(f.gymId), f.person.id, { revision: 1 }, queue());
  try { await waitingFor('signed_links', 'update'); } finally { release.release(); }
  const checkoutResult = await checkout;
  if (needsReview) expect(checkoutResult).toMatchObject({ code: 'conflict', message: 'Invoice cannot be paid' });
  else expect(checkoutResult).toBe(prepared);
  await expect(erasing).resolves.toMatchObject({ householdErased: true });
  expect(await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, bill.id))))
    .toMatchObject([{ needsReview: true }]);
  expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, link.id))))
    .toMatchObject([{ revokedAt: clock.now() }]);
});
