// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, like, lt, lte, notExists, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { authVerification, authUser, authAccount, databaseCode, householdUsers, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { z } from 'zod';
import { idSchema } from '@plaingym/shared/contracts';
import { passwordAdapter } from './password.js';

/** The household login an invitation grants. The link itself is created only when the invitation is accepted. */
export const portalInvitationBindingSchema = z.strictObject({
  userId: z.uuid(), householdId: z.uuid(), scope: z.enum(['payer', 'member']), memberId: z.uuid().nullable(),
});
export type PortalInvitationBinding = z.infer<typeof portalInvitationBindingSchema>;
export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface AcceptPortalInvitation {
  readonly gymId: string;
  readonly token: string;
  /** Required in password mode, refused otherwise. */
  readonly password?: string | undefined;
  readonly passwordMode: boolean;
  readonly clock: Clock;
}
/** Runs in the consuming transaction, after the invitation and its user are locked. Throw to reject. */
export type ConsumePortalInvitation = (tx: Transaction, binding: PortalInvitationBinding) => Promise<void>;
const lifetime = 7 * 24 * 60 * 60 * 1000;
const prefix = (gymId: string) => `portal-invitation:${gymId}:`;
const identifier = (gymId: string, token: string) => prefix(gymId) + createHash('sha256').update(token).digest('hex');
const invalid = () => new AppError('not_found', 'Invitation is invalid or expired');
function bindingOf(value: string) {
  try { return portalInvitationBindingSchema.parse(JSON.parse(value)); } catch { throw invalid(); }
}
/** A pending passwordless onboarding claim's hold on its identity, one per user and onboarding link. */
const claimPrefix = (gymId: string) => `portal-claim:${gymId}:`;
const claimKey = (gymId: string, linkId: string) => claimPrefix(idSchema.parse(gymId).toLowerCase()) + idSchema.parse(linkId).toLowerCase();
/** This gym's invitation rows. The indexed columns are set only by `issue` (and the upgrade's backfill); the identifier prefix stays the gym check. */
const invitationsOf = (gymId: string) => and(eq(authVerification.gymId, gymId), isNotNull(authVerification.householdId), like(authVerification.identifier, prefix(gymId) + '%'));
/** This gym's invitation rows and onboarding claim holds: the rows its expiry sweep deletes. */
const portalRowsOf = (gymId: string) => and(eq(authVerification.gymId, gymId), isNotNull(authVerification.householdId),
  or(like(authVerification.identifier, prefix(gymId) + '%'), like(authVerification.identifier, claimPrefix(gymId) + '%')));
/**
 * Deletes the identities invitations provisioned once nothing else holds them: no account (password or OAuth), no other invitation
 * row or onboarding claim hold (`holdClaim`; an expired one still counts until it is swept, so the last removal decides), and no
 * household link, staff role or history. Runs in the transaction that removed the invitations.
 *
 * It filters first and locks only identities with no account or link, so one that keeps either is never locked (its
 * sign-ins never wait on a sweep). The delete then checks again under the locks: an acceptance locks the same user before linking,
 * so it either commits first and keeps the identity, or finds its invitation gone. Inviting and onboarding claims lock it too
 * (`issue`, `holdClaim`). This gym's links are checked directly; links, roles and history in other gyms are invisible here, and
 * their foreign keys refuse the delete instead (they bypass row-level security), which a savepoint absorbs. Returns how many
 * identities were deleted.
 */
async function removeOrphanedInvitees(tx: Transaction, userIds: readonly string[]) {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return 0;
  const noLogin = and(notExists(tx.select({ id: authAccount.id }).from(authAccount).where(eq(authAccount.userId, authUser.id))),
    notExists(tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, authUser.id))));
  // The callers' own deletions are already invisible here. Another invitation row is only checked under the lock: two removals
  // of an identity's last two invitations each still see the other's row until it commits, and the lock orders them.
  const holdsNothing = and(noLogin, notExists(tx.select({ id: authVerification.id }).from(authVerification).where(eq(authVerification.userId, authUser.id))));
  const candidates = (await tx.select({ id: authUser.id }).from(authUser).where(and(inArray(authUser.id, ids), noLogin))
    .orderBy(asc(authUser.id))).map(row => row.id);
  if (!candidates.length) return 0;
  const remove = async (batch: readonly string[]): Promise<number> => {
    try {
      return (await tx.transaction(async savepoint => {
        // One lock order for every caller, so two gyms' sweeps sharing invitees never wait on each other in a cycle. Taken in the
        // savepoint, so a refused batch releases its locks: an identity another gym holds stays unlocked for the rest of the caller's
        // transaction (a gym deletion's whole cascade, for one). Halves run in ID order, so the order holds across retries.
        await savepoint.select({ id: authUser.id }).from(authUser).where(inArray(authUser.id, [...batch])).orderBy(asc(authUser.id)).for('update');
        // A new statement, so it sees what committed while the lock waited.
        return savepoint.delete(authUser).where(and(inArray(authUser.id, [...batch]), holdsNothing)).returning({ id: authUser.id });
      })).length;
    } catch (error) {
      if (databaseCode(error) !== '23503') throw error;
      if (batch.length === 1) return 0;
      // Another gym holds at least one of them: halve the batch, so each held identity costs a few savepoints, not one per identity.
      const half = Math.ceil(batch.length / 2);
      return await remove(batch.slice(0, half)) + await remove(batch.slice(half));
    }
  };
  return remove(candidates);
}

/**
 * Runs in the system transaction that deletes a gym, before the gym row: deletes the gym's invitations and onboarding claim holds
 * (the gym's cascade would take them without this cleanup) and the identities left holding nothing. Its household links,
 * staff roles and history still exist here, and their foreign keys keep those identities, as they keep links in other gyms;
 * another gym's invitation row is visible in system context and keeps its invitee too. Returns how many identities were deleted.
 */
export async function removeGymInvitees(tx: Transaction, gymId: string): Promise<number> {
  const id = idSchema.parse(gymId).toLowerCase();
  const rows = await tx.delete(authVerification).where(or(eq(authVerification.gymId, id), like(authVerification.identifier, prefix(id) + '%')))
    .returning({ userId: authVerification.userId });
  return removeOrphanedInvitees(tx, rows.flatMap(row => row.userId ? [row.userId] : []));
}

/** What a passwordless claim proves by email, before any household link exists. */
export type PortalClaim =
  | { readonly kind: 'onboarding'; readonly gymId: string; readonly userId: string; readonly linkId: string; readonly expiresAt: Date }
  | { readonly kind: 'invitation'; readonly gymId: string; readonly userId: string; readonly invitationId: string; readonly expiresAt: Date };
const claimSchema = z.strictObject({ k: z.enum(['onboarding', 'invitation']), g: z.uuid(), u: z.uuid(), r: z.uuid(), x: z.int().positive() });
/** Signed, stateless claim codes carried by the magic-link callback. The code itself is not stored (an onboarding claim
 * writes only a hold that keeps its identity, `holdClaim`): completion needs the signed-in session of the same user and
 * rechecks the link or invitation the code names. */
export function createPortalClaimCodes(secret: string) {
  const key = new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'plaingym portal claim v1', 32));
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url');
  return {
    seal(claim: PortalClaim): string {
      const payload = Buffer.from(JSON.stringify(claimSchema.parse({ k: claim.kind, g: claim.gymId, u: claim.userId,
        r: claim.kind === 'onboarding' ? claim.linkId : claim.invitationId, x: claim.expiresAt.getTime() }))).toString('base64url');
      return payload + '.' + mac(payload);
    },
    open(code: string, now: Date): PortalClaim | null {
      const [payload, signature, extra] = code.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = Buffer.from(mac(payload)), actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      let value: z.infer<typeof claimSchema>;
      try { value = claimSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); } catch { return null; }
      if (value.x <= now.getTime()) return null;
      const base = { gymId: value.g, userId: value.u, expiresAt: new Date(value.x) };
      return value.k === 'onboarding' ? { kind: 'onboarding', ...base, linkId: value.r } : { kind: 'invitation', ...base, invitationId: value.r };
    },
  };
}

/** Invitation tokens live hashed in `auth_verification`, bound to the issuing gym and the household login they grant. */
export function createPortalInvitationStore(database = systemDatabase) {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  return {
    /** Removes invitations for an erased/deleted member, or all invitations and claim holds for their last household.
     * Called after the application transaction commits; system rows use this module's own pool. */
    async revokeFor(gymId: string, householdId: string, memberId?: string) {
      assertNoTransaction('auth.revokeInvitationsFor');
      const gym = idSchema.parse(gymId).toLowerCase(), home = idSchema.parse(householdId).toLowerCase();
      const member = memberId === undefined ? undefined : idSchema.parse(memberId).toLowerCase();
      return forGym(gym, async tx => {
        // `issue` serializes a strict binding with JSON.stringify. Claims are household-wide, without a member ID.
        const rows = await tx.delete(authVerification).where(and(portalRowsOf(gym), eq(authVerification.householdId, home),
          member ? like(authVerification.value, '%"memberId":"' + member + '"%') : undefined))
          .returning({ userId: authVerification.userId });
        await removeOrphanedInvitees(tx, rows.flatMap(row => row.userId ? [row.userId] : []));
        return rows.length;
      });
    },
    /** A staff-authorized household listing may display the linked identity's email. */
    async loginEmails(gymId: string, householdId: string) {
      return forGym(gymId, tx => tx.select({ id: householdUsers.id, email: authUser.email }).from(householdUsers)
        .innerJoin(authUser, eq(authUser.id, householdUsers.userId)).where(eq(householdUsers.householdId, householdId)));
    },
    /** The household's unexpired invitations with the invitee's login email, newest first. Gym-scoped and for one household:
     * the caller is a staff member authorized for that household. Tokens are stored hashed and never returned. */
    async outstanding(gymId: string, householdId: string, clock: Clock) {
      // Bindings store IDs in lowercase, while a route accepts either case.
      const id = idSchema.parse(householdId).toLowerCase();
      return forGym(gymId, async tx => {
        // Served by `auth_verification_portal_invitation_idx`; the parsed binding decides.
        const rows = await tx.select().from(authVerification).where(and(invitationsOf(gymId), eq(authVerification.householdId, id),
          gt(authVerification.expiresAt, clock.now())))
          .orderBy(desc(authVerification.expiresAt), asc(authVerification.id)).limit(100);
        const invitations = rows.flatMap(row => {
          try { return [{ id: row.id, expiresAt: row.expiresAt, binding: bindingOf(row.value) }]; } catch { return []; }
        }).filter(row => row.binding.householdId === id);
        const users = invitations.length ? await tx.select({ id: authUser.id, email: authUser.email }).from(authUser)
          .where(inArray(authUser.id, invitations.map(row => row.binding.userId))) : [];
        return invitations.flatMap(row => {
          const email = users.find(user => user.id === row.binding.userId)?.email;
          return email ? [{ ...row, email }] : [];
        });
      });
    },
    /** Runs `read` in one transaction of this gym, with `payerInvited(household)`: a condition that holds while that household
     * has an unexpired payer invitation (the dashboard's confirmation shortlist leaves them out). The transaction is on this
     * module's pool, so it has system context as well as the gym: business tables are scoped to the gym as in any `forGym`
     * transaction, but system tables aren't. Keep `read` to gym tables and short (the pool has two connections); the lint rule
     * already keeps system tables out of area code. */
    async withPayerInvitations<T>(gymId: string, clock: Clock, read: (tx: Transaction, payerInvited: (household: AnyPgColumn) => SQL) => Promise<T>) {
      assertNoTransaction('auth.payerInvitations');
      return forGym(gymId, tx => read(tx, household => exists(tx.select({ id: authVerification.id }).from(authVerification)
        // Served by `auth_verification_portal_invitation_idx`. A row a process on the previous release wrote after the upgrade has
        // no scope, so its value decides; `issue` writes it with JSON.stringify of the strict binding, so this is the exact text.
        .where(and(invitationsOf(gymId), eq(authVerification.householdId, household), gt(authVerification.expiresAt, clock.now()),
          or(eq(authVerification.scope, 'payer'), and(isNull(authVerification.scope), like(authVerification.value, '%"scope":"payer"%'))))))));
    },
    /** Deletes one of the household's unexpired invitations, so accepting it fails, and the identity it provisioned if nothing
     * else holds it (`removeOrphanedInvitees`). `revoked` runs in the same transaction (the audit); the invitation must belong to
     * this gym and household, otherwise it is not found. */
    async revoke(input: { gymId: string; householdId: string; invitationId: string; clock: Clock },
      revoked: (tx: Transaction, binding: PortalInvitationBinding) => Promise<void>) {
      assertNoTransaction('auth.revokeInvitation');
      await forGym(input.gymId, async tx => {
        const [invite] = await tx.select().from(authVerification).where(eq(authVerification.id, input.invitationId)).for('update');
        if (!invite || !invite.identifier.startsWith(prefix(input.gymId)) || invite.expiresAt <= input.clock.now()) throw invalid();
        const binding = bindingOf(invite.value);
        if (binding.householdId !== input.householdId.toLowerCase()) throw invalid();
        await revoked(tx, binding);
        await tx.delete(authVerification).where(eq(authVerification.id, invite.id));
        await removeOrphanedInvitees(tx, [binding.userId]);
      });
    },
    /** Deletes this gym's expired invitations and onboarding claim holds in batches, each with the identities left holding nothing,
     * and returns the counts. Rows another transaction holds are skipped until the next run. */
    async expire(gymId: string, clock: Clock, batch = 100) {
      assertNoTransaction('auth.expireInvitations');
      let expired = 0, removed = 0;
      for (;;) {
        const done = await forGym(gymId, async tx => {
          const rows = await tx.select({ id: authVerification.id, userId: authVerification.userId }).from(authVerification)
            .where(and(portalRowsOf(gymId), lte(authVerification.expiresAt, clock.now())))
            .orderBy(asc(authVerification.id)).limit(batch).for('update', { skipLocked: true });
          if (!rows.length) return true;
          await tx.delete(authVerification).where(inArray(authVerification.id, rows.map(row => row.id)));
          expired += rows.length;
          removed += await removeOrphanedInvitees(tx, rows.flatMap(row => row.userId ? [row.userId] : []));
          return rows.length < batch;
        });
        if (done) return { expired, removed };
      }
    },
    /** Deletes the install's expired verification rows that aren't portal invitations (magic links, staff invitations), in batches,
     * and returns how many. Better Auth's own cleanup is off (`service.ts`), so expired portal invitations stay until `expire`. */
    async sweepExpired(clock: Clock, batch = 1000) {
      assertNoTransaction('auth.sweepVerifications');
      let removed = 0;
      for (;;) {
        const due = database().select({ id: authVerification.id }).from(authVerification)
          .where(and(isNull(authVerification.householdId), lt(authVerification.expiresAt, clock.now()))).limit(batch);
        const rows = await database().delete(authVerification).where(inArray(authVerification.id, due)).returning({ id: authVerification.id });
        removed += rows.length;
        if (rows.length < batch) return removed;
      }
    },
    /** Runs in the caller's transaction. Replaces outstanding links for the binding and returns the raw token once. */
    async issue(tx: Transaction, gymId: string, binding: PortalInvitationBinding, clock: Clock) {
      const token = randomBytes(32).toString('hex'), value = JSON.stringify(portalInvitationBindingSchema.parse(binding));
      const expiresAt = new Date(clock.now().getTime() + lifetime);
      await tx.delete(authVerification).where(and(eq(authVerification.userId, binding.userId), eq(authVerification.householdId, binding.householdId),
        eq(authVerification.value, value)));
      // Invitation rows first, then the invitee, as revoking and accepting lock them. A cleanup that deleted the invitee
      // meanwhile (`removeOrphanedInvitees`) leaves nothing to lock, and staff try again.
      if (!(await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, binding.userId)).for('key share'))[0])
        throw new AppError('conflict', 'Account changed, try again');
      await tx.insert(authVerification).values({ identifier: identifier(gymId, token), value, expiresAt, gymId, householdId: binding.householdId,
        userId: binding.userId, scope: binding.scope, createdAt: clock.now(), updatedAt: clock.now() });
      return { token, expiresAt };
    },
    /** Runs in a passwordless onboarding claim's transaction, after the onboarding link is locked. Until the claim code expires,
     * this row keeps the identity from the invitee cleanup (`removeOrphanedInvitees`), so an invitation for the same address
     * that is revoked or expires meanwhile never deletes the user the code names. Asking again replaces the hold. */
    async holdClaim(tx: Transaction, gymId: string, claim: { userId: string; householdId: string; linkId: string }, expiresAt: Date, clock: Clock) {
      const key = claimKey(gymId, claim.linkId);
      await tx.delete(authVerification).where(and(eq(authVerification.userId, claim.userId), eq(authVerification.identifier, key)));
      // Hold rows first, then the user, as the cleanup locks them. A cleanup that deleted the user meanwhile leaves nothing to
      // lock, and the person asks again.
      if (!(await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, claim.userId)).for('key share'))[0])
        throw new AppError('conflict', 'Account changed, try again');
      await tx.insert(authVerification).values({ identifier: key, value: JSON.stringify({ userId: claim.userId, householdId: claim.householdId, linkId: claim.linkId }),
        expiresAt, gymId, householdId: claim.householdId, userId: claim.userId, createdAt: clock.now(), updatedAt: clock.now() });
    },
    /** Completes a passwordless onboarding claim in one transaction, for the user its code names, after that user proved the
     * address by signing in. `consume` locks the onboarding link, then calls `settle`, which deletes the claim's hold and locks
     * the user (the cleanup's order: verification rows, then the user), and then links it. A user the cleanup deleted anyway (a
     * code issued before holds existed, or one whose hold was swept) is not found, so the person restarts from the onboarding
     * link instead of meeting a foreign-key error. */
    async completeOnboarding(input: { gymId: string; userId: string; linkId: string },
      consume: (tx: Transaction, settle: () => Promise<void>) => Promise<void>) {
      assertNoTransaction('auth.completeOnboardingClaim');
      await forGym(input.gymId, tx => consume(tx, async () => {
        await tx.delete(authVerification).where(and(eq(authVerification.userId, input.userId),
          eq(authVerification.identifier, claimKey(input.gymId, input.linkId))));
        if (!(await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, input.userId)).for('update'))[0])
          throw new AppError('not_found', 'Claim is invalid or expired');
      }));
    },
    /** A live invitation and its invitee's login email, without consuming it (passwordless acceptance). */
    async inspect(gymId: string, token: string, clock: Clock) {
      assertNoTransaction('auth.inspectInvitation');
      if (!invitationTokenSchema.safeParse(token).success) throw invalid();
      const [snapshot] = await database().select().from(authVerification).where(eq(authVerification.identifier, identifier(gymId, token)));
      if (!snapshot || snapshot.expiresAt <= clock.now()) throw invalid();
      const binding = bindingOf(snapshot.value);
      const [user] = await database().select({ email: authUser.email }).from(authUser).where(eq(authUser.id, binding.userId));
      if (!user) throw invalid();
      return { invitationId: snapshot.id, expiresAt: snapshot.expiresAt, binding, email: user.email };
    },
    /** Consumes an invitation by ID for the user it was issued to, after that user proved the address by signing in. */
    async redeem(input: { gymId: string; invitationId: string; userId: string; clock: Clock }, consume: ConsumePortalInvitation) {
      assertNoTransaction('auth.redeemInvitation');
      await forGym(input.gymId, async tx => {
        const [invite] = await tx.select().from(authVerification).where(eq(authVerification.id, input.invitationId)).for('update');
        if (!invite || !invite.identifier.startsWith(prefix(input.gymId)) || invite.expiresAt <= input.clock.now()) throw invalid();
        const binding = bindingOf(invite.value);
        if (binding.userId !== input.userId) throw invalid();
        const [user] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, binding.userId)).for('update');
        if (!user) throw invalid();
        await consume(tx, binding);
        await tx.delete(authVerification).where(eq(authVerification.id, invite.id));
      });
    },
    /** Password mode: consumption, the caller's writes and any new password commit together; hashing happens before the transaction.
     * Without password login the invitee proves the address through a login link instead (inspect, then redeem). */
    async accept(input: AcceptPortalInvitation, consume: ConsumePortalInvitation) {
      assertNoTransaction('auth.acceptInvitation');
      if (!invitationTokenSchema.safeParse(input.token).success) throw invalid();
      const key = identifier(input.gymId, input.token);
      const [snapshot] = await database().select().from(authVerification).where(eq(authVerification.identifier, key));
      if (!snapshot || snapshot.expiresAt <= input.clock.now()) throw invalid();
      const binding = bindingOf(snapshot.value);
      if (!input.passwordMode) throw new AppError('forbidden', 'Password login is disabled');
      if (!input.password) throw new AppError('invalid_request', 'Password required');
      if (input.password.length < 12 || input.password.length > 128) throw new AppError('invalid_request', 'Password must contain 12 to 128 characters');
      const [credential] = await database().select().from(authAccount).where(and(eq(authAccount.userId, binding.userId), eq(authAccount.providerId, 'credential')));
      // An invite never replaces an existing password. Existing password users prove their credentials.
      if (credential?.password && !await passwordAdapter.verify({ hash: credential.password, password: input.password }))
        throw new AppError('forbidden', 'Existing account requires its current password');
      const hash = credential?.password ? undefined : await passwordAdapter.hash(input.password);
      await forGym(input.gymId, async (tx) => {
        const [invite] = await tx.select().from(authVerification).where(eq(authVerification.id, snapshot.id)).for('update');
        if (!invite || invite.expiresAt <= input.clock.now() || invite.value !== snapshot.value) throw invalid();
        const [user] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, binding.userId)).for('update');
        if (!user) throw invalid();
        await consume(tx, binding);
        const [current] = await tx.select().from(authAccount).where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, 'credential'))).for('update');
        if (current?.password !== credential?.password) throw new AppError('conflict', 'Account credentials changed');
        if (hash) {
          if (current) await tx.update(authAccount).set({ password: hash, updatedAt: input.clock.now() }).where(eq(authAccount.id, current.id));
          else await tx.insert(authAccount).values({ userId: user.id, accountId: user.id, providerId: 'credential', password: hash, createdAt: input.clock.now(), updatedAt: input.clock.now() });
        }
        await tx.delete(authVerification).where(eq(authVerification.id, invite.id));
      });
    },
  };
}
export type PortalInvitationStore = ReturnType<typeof createPortalInvitationStore>;
