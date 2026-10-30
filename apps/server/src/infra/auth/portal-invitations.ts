// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, like } from 'drizzle-orm';
import { authVerification, authUser, authAccount, householdUsers, type Transaction } from '@plaingym/db';
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

/** What a passwordless claim proves by email, before any household link exists. */
export type PortalClaim =
  | { readonly kind: 'onboarding'; readonly gymId: string; readonly userId: string; readonly linkId: string; readonly expiresAt: Date }
  | { readonly kind: 'invitation'; readonly gymId: string; readonly userId: string; readonly invitationId: string; readonly expiresAt: Date };
const claimSchema = z.strictObject({ k: z.enum(['onboarding', 'invitation']), g: z.uuid(), u: z.uuid(), r: z.uuid(), x: z.int().positive() });
/** Signed, stateless claim codes carried by the magic-link callback. Nothing is stored for a pending claim:
 * completion needs the signed-in session of the same user and rechecks the link or invitation the code names. */
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
        // The household ID is a validated UUID, so the substring match only narrows the scan; the parsed binding decides.
        const rows = await tx.select().from(authVerification).where(and(like(authVerification.identifier, prefix(gymId) + '%'),
          gt(authVerification.expiresAt, clock.now()), like(authVerification.value, `%"householdId":"${id}"%`)))
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
    /** Deletes one of the household's unexpired invitations, so accepting it fails. `revoked` runs in the same transaction
     * (the audit); the invitation must belong to this gym and household, otherwise it is not found. */
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
      });
    },
    /** Runs in the caller's transaction. Replaces outstanding links for the binding and returns the raw token once. */
    async issue(tx: Transaction, gymId: string, binding: PortalInvitationBinding, clock: Clock) {
      const token = randomBytes(32).toString('hex'), value = JSON.stringify(portalInvitationBindingSchema.parse(binding));
      const expiresAt = new Date(clock.now().getTime() + lifetime);
      await tx.delete(authVerification).where(eq(authVerification.value, value));
      await tx.insert(authVerification).values({ identifier: identifier(gymId, token), value, expiresAt, createdAt: clock.now(), updatedAt: clock.now() });
      return { token, expiresAt };
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
