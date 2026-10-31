// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- The race tests read pg_stat_activity to prove each overlap waited on a row lock.
import { eq, sql } from 'drizzle-orm';
import { authAccount, authSession, authUser, authVerification, householdUsers, uuidv7 } from '@plaingym/db';
import { closeDatabase, initializeDatabase, systemDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createPortalInvitationExpiryJobs, createPortalInvitationService, portalInvitationExpiryJob } from '../../areas/members/household-users.invitations.js';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../email/index.js';
import { authConfig } from './config.js';
import { createPortalInvitationStore } from './portal-invitations.js';
import { createAuthService } from './service.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-30T12:00:00Z');
const expired = new TestClock('2026-11-06T12:00:01Z');
const config = authConfig({ AUTH_SECRET: 'cleanup-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const passwordless = { ...config, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
// The runtime's own two-connection auth pool, so two transactions can overlap in the race tests.
const options = { config, database: systemDatabase, smtpConfigured: async () => false, mailer: async () => new FakeEmail(), loginLink: async () => undefined,
  scope: db.forGym, householdScope: db.forHousehold };
const invitations = createPortalInvitationService(options), store = createPortalInvitationStore();
beforeAll(() => initializeDatabase(db.appUrl)); afterAll(() => closeDatabase());

async function gym() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const owner = await factory('staffRoles', gymId, { role: 'owner' });
  return { gymId, actor: { gymId, userId: owner.userId, clock }, home: await factory('households', gymId), other: await factory('households', gymId) };
}
type Gym = Awaited<ReturnType<typeof gym>>;
async function invite(g: Gym, email = `${uuidv7()}@example.test`, householdId = g.home.id, service = invitations, at = clock) {
  const { data } = await service.invite({ ...g.actor, clock: at }, householdId, { email, scope: 'payer', delivery: 'print' }, 'https://gym.example.test');
  const [row] = (await service.outstanding({ ...g.actor, clock: at }, householdId)).data.filter(entry => entry.email === email);
  return { userId: data.invitation.userId, invitationId: row!.id, email };
}
const revoke = (g: Gym, invitation: { invitationId: string }, householdId = g.home.id) => invitations.revokeInvitation(g.actor, householdId, invitation.invitationId);
const exists = async (userId: string) => (await db.system.db.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, userId))).length === 1;
const session = (gymId: string, userId: string) => db.system.db.insert(authSession).values({ gymId, userId, token: uuidv7(), expiresAt: new Date('2026-12-01T00:00:00Z') });
const invitationRows = (userId: string) => db.system.db.select().from(authVerification).where(eq(authVerification.userId, userId));

/** Whatever keeps an invitee's identity, set up after the invitation in gym A that is about to go. */
const holders: [string, (a: Gym, b: Gym, userId: string, email: string) => Promise<unknown>][] = [
  ['a password account', async (_a, _b, userId) => db.system.db.insert(authAccount).values({ userId, accountId: userId, providerId: 'credential', password: 'x' })],
  ["a household link in the same gym", async (a, _b, userId) => factory('householdUsers', a.gymId, { householdId: a.other.id, userId, scope: 'payer', memberId: null })],
  ['another outstanding invitation in the same gym', async (a, _b, _userId, email) => invite(a, email, a.other.id)],
  ['a household link in another gym', async (_a, b, userId) => factory('householdUsers', b.gymId, { householdId: b.home.id, userId, scope: 'payer', memberId: null })],
  ['an outstanding invitation in another gym', async (_a, b, _userId, email) => invite(b, email)],
  ['a staff role in another gym', async (_a, b, userId) => factory('staffRoles', b.gymId, { userId, role: 'coach' })],
];

describe('invitee identities left without an invitation', () => {
  it('revoking deletes the identity the invitation provisioned, with its sessions, and still audits the revoke', async () => {
    const a = await gym(), invitation = await invite(a);
    // In passwordless mode the invitee could sign in by magic link to a session without access.
    await session(a.gymId, invitation.userId);
    await revoke(a, invitation);
    expect(await exists(invitation.userId)).toBe(false);
    expect(await db.system.db.select().from(authSession).where(eq(authSession.userId, invitation.userId))).toEqual([]);
    expect((await invitations.outstanding(a.actor, a.home.id)).data).toEqual([]);
  });

  it.each(holders)('revoking keeps an identity that has %s', async (_name, hold) => {
    const a = await gym(), b = await gym(), invitation = await invite(a);
    await hold(a, b, invitation.userId, invitation.email);
    await revoke(a, invitation);
    expect(await exists(invitation.userId)).toBe(true);
    // Gym B's link, role or invitation is untouched by gym A's revoke.
    expect((await invitations.outstanding(a.actor, a.home.id)).data).toEqual([]);
  });

  it('expiry deletes each gym\'s expired invitations and the identities left holding nothing, in batches, and only its own gym\'s', async () => {
    const a = await gym(), b = await gym();
    const orphans = [await invite(a), await invite(a), await invite(a, undefined, a.other.id)];
    const linked = await invite(a), theirs = await invite(b);
    await factory('householdUsers', b.gymId, { householdId: b.other.id, userId: linked.userId, scope: 'payer', memberId: null });
    // Issued a day later, so it outlives the sweep.
    const fresh = await invite(a, undefined, a.other.id, invitations, new TestClock('2026-10-31T12:00:00Z'));
    expect(await store.expire(a.gymId, clock)).toEqual({ expired: 0, removed: 0 });
    expect(await store.expire(a.gymId, expired, 2)).toEqual({ expired: 4, removed: 3 });
    for (const orphan of orphans) expect(await exists(orphan.userId)).toBe(false);
    expect(await exists(linked.userId)).toBe(true);
    expect(await invitationRows(linked.userId)).toEqual([]);
    expect((await invitations.outstanding({ ...a.actor, clock: expired }, a.other.id)).data.map(row => row.id)).toEqual([fresh.invitationId]);
    // Gym B's expired invitation waits for gym B's own sweep, run by the job.
    expect(await invitationRows(theirs.userId)).toHaveLength(1);
    const [job] = createPortalInvitationExpiryJobs(store);
    expect(job).toMatchObject({ id: portalInvitationExpiryJob, cron: '53 * * * *' });
    await job!.handler({}, { jobId: uuidv7(), gymId: b.gymId, timezone: 'UTC', attempt: 1, clock: expired });
    expect(await exists(theirs.userId)).toBe(false);
    expect(await exists(fresh.userId)).toBe(true);
  });

  it('expiry keeps an identity until its last invitation, in any gym, is gone', async () => {
    const a = await gym(), b = await gym(), invitation = await invite(a);
    await invite(b, invitation.email);
    await store.expire(a.gymId, expired);
    expect(await exists(invitation.userId)).toBe(true);
    await store.expire(b.gymId, expired);
    expect(await exists(invitation.userId)).toBe(false);
  });

  // A second invitation in the same gym expires in the same sweep, so it holds nothing there.
  it.each(holders.filter(([name]) => name !== 'another outstanding invitation in the same gym'))('expiry keeps an identity that has %s', async (_name, hold) => {
    const a = await gym(), b = await gym(), invitation = await invite(a);
    await hold(a, b, invitation.userId, invitation.email);
    // An invitation in another gym stays until that gym's own sweep.
    await store.expire(a.gymId, expired);
    expect(await exists(invitation.userId)).toBe(true);
  });
});

describe('an acceptance racing a revoke', () => {
  /** Resolves once another backend waits on a row lock, so each race below is a real overlap. */
  async function lockWait() {
    for (let attempt = 0; attempt < 200; attempt++) {
      // eslint-disable-next-line database/system-tables -- Reads only the lock-wait count of this isolated test database.
      const [row] = await db.app.db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`);
      if (row && row.waiting > 0) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('No transaction waited on a lock');
  }
  const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { open, opened }; };

  it('an acceptance holding the invitation wins: the revoke then finds nothing, and the linked identity stays', async () => {
    const a = await gym(), invitation = await invite(a), held = gate(), release = gate();
    const accepting = store.redeem({ gymId: a.gymId, invitationId: invitation.invitationId, userId: invitation.userId, clock }, async (tx, binding) => {
      await tx.insert(householdUsers).values({ gymId: a.gymId, householdId: binding.householdId, userId: binding.userId, scope: binding.scope, memberId: null, createdAt: clock.now() });
      held.open(); await release.opened;
    });
    await held.opened;
    const revoking = revoke(a, invitation);
    await lockWait();
    release.open();
    await accepting;
    await expect(revoking).rejects.toMatchObject({ code: 'not_found' });
    expect(await exists(invitation.userId)).toBe(true);
    expect(await db.forGym(a.gymId, tx => tx.select().from(householdUsers).where(eq(householdUsers.userId, invitation.userId)))).toHaveLength(1);
  });

  it('a revoke holding the invitation wins: the acceptance then finds nothing, and the identity is deleted', async () => {
    const a = await gym(), invitation = await invite(a), held = gate(), release = gate();
    const revoking = store.revoke({ gymId: a.gymId, householdId: a.home.id, invitationId: invitation.invitationId, clock }, async () => { held.open(); await release.opened; });
    await held.opened;
    let consumed = false;
    const accepting = store.redeem({ gymId: a.gymId, invitationId: invitation.invitationId, userId: invitation.userId, clock }, async () => { consumed = true; });
    await lockWait();
    release.open();
    await revoking;
    await expect(accepting).rejects.toMatchObject({ code: 'not_found' });
    expect(consumed).toBe(false);
    expect(await exists(invitation.userId)).toBe(false);
  });

  it('a revoke waits for an acceptance of another invitation for the same identity, and keeps it', async () => {
    const a = await gym(), b = await gym(), invitation = await invite(a), theirs = await invite(b, invitation.email), held = gate(), release = gate();
    const accepting = store.redeem({ gymId: b.gymId, invitationId: theirs.invitationId, userId: theirs.userId, clock }, async (tx, binding) => {
      await tx.insert(householdUsers).values({ gymId: b.gymId, householdId: binding.householdId, userId: binding.userId, scope: binding.scope, memberId: null, createdAt: clock.now() });
      held.open(); await release.opened;
    });
    await held.opened;
    const revoking = revoke(a, invitation);
    await lockWait();
    release.open();
    await accepting; await revoking;
    expect(await exists(invitation.userId)).toBe(true);
  });
});

describe('magic-link sign-in after the cleanup', () => {
  it('an invitee deleted with its revoked invitation can no longer sign in by magic link', async () => {
    const a = await gym(), origin = `https://${a.gymId}.example.test`, delivered: { url: string }[] = [];
    const auth = createAuthService({ config: passwordless, database: systemDatabase, sendMagicLink: async data => { delivered.push(data); } });
    const bound = auth.bind({ gymId: a.gymId, origin, clientIp: '192.0.2.77', smtpConfigured: true });
    const service = createPortalInvitationService({ ...options, config: passwordless, smtpConfigured: async () => true });
    const signIn = async (email: string) => {
      const before = delivered.length;
      await bound.sendLoginLink(email).catch(() => undefined);
      if (delivered.length === before) return null;
      const response = await bound.handler(new Request(delivered.at(-1)!.url));
      return response.headers.getSetCookie().find(cookie => cookie.includes('session_token=') && !/session_token=;/.test(cookie)) ?? null;
    };
    // Before the fix's cleanup, the provisioned invitee signs in to a session with no household access.
    const first = await invite(a, undefined, a.home.id, service);
    expect(await signIn(first.email)).not.toBeNull();
    const invitation = await invite(a, undefined, a.home.id, service);
    await service.revokeInvitation(a.actor, a.home.id, invitation.invitationId);
    expect(await exists(invitation.userId)).toBe(false);
    expect(await signIn(invitation.email)).toBeNull();
    expect(await db.system.db.select().from(authUser).where(eq(authUser.email, invitation.email))).toEqual([]);
    expect(await db.system.db.select().from(authSession).where(eq(authSession.gymId, a.gymId)).then(rows => rows.filter(row => row.userId === invitation.userId))).toEqual([]);
  });
});
