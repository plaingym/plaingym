// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { forGym, forHousehold, householdUsers, households, members, signedLinks, staffRoles, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, canStaff, createTranslator, type Clock, type StaffRole } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { portalClaimCompletionRequestSchema, portalClaimRequestSchema, portalInvitationRequestSchema, portalOnboardingClaimRequestSchema, type PortalInvitationRequest } from '@plaingym/shared/contracts';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createPortalClaimCodes, createPortalInvitationStore, type PortalInvitationBinding, type PortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import type { Email } from '../../infra/email/index.js';
import { notFound } from '../../core/interfaces/common.js';
import type { JobRegistration } from '../../core/registry.js';
import { assertCanResetPassword } from '../staff/auth.reset.js';
import { assertPortalLoginTarget } from './household-users.js';

type Actor = { gymId: string; userId: string; clock: Clock; timezone?: string };
/** Sends a login link whose callback returns to the portal claim page with this claim code. */
export type PortalLoginLinkSender = (input: { gymId: string; email: string; claim: string }) => Promise<void>;
export interface PortalInvitationOptions {
  config: AuthConfig;
  smtpConfigured(gymId: string): Promise<boolean>;
  mailer(gymId: string): Email | null | Promise<Email | null>;
  /** Passwordless claims and invitations prove the address through this login link before any household link exists. */
  loginLink: PortalLoginLinkSender;
  database?: Parameters<typeof createAccountService>[1];
  householdScope?: typeof forHousehold;
  scope?: typeof forGym;
}
/** A claim code outlives the login link it rides on, but never the onboarding link or invitation it names. */
const claimLifetime = 60 * 60 * 1000;
async function refuseStaff(tx: Transaction, userId: string) {
  if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)))[0]) throw new AppError('forbidden', 'Protected account');
}
/** Creates the household login an invitation or onboarding claim grants, once its address is proven. */
async function grant(tx: Transaction, gymId: string, binding: PortalInvitationBinding, clock: Clock) {
  const [created] = await tx.insert(householdUsers).values({ gymId, householdId: binding.householdId, userId: binding.userId, scope: binding.scope, memberId: binding.memberId, createdAt: clock.now() }).onConflictDoNothing().returning();
  const login = created ?? (await tx.select().from(householdUsers).where(and(eq(householdUsers.householdId, binding.householdId), eq(householdUsers.userId, binding.userId))).for('update'))[0];
  // An existing link with another role, or a member already linked to another login, is a conflict.
  if (!login || login.scope !== binding.scope || login.memberId !== binding.memberId) throw new AppError('conflict', 'Portal login already linked');
  return login;
}
async function lockOnboardingLink(tx: Transaction, linkId: string, clock: Clock) {
  const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
  if (!link || link.purpose !== 'onboarding' || link.usedAt || link.revokedAt || link.expiresAt <= clock.now()) notFound();
  return link;
}
export function createPortalInvitationService(options: PortalInvitationOptions) {
  const accounts = createAccountService(options.config, options.database), store = createPortalInvitationStore(options.database);
  const codes = createPortalClaimCodes(options.config.secret), scope = options.scope ?? forGym;
  const householdScope = options.householdScope ?? forHousehold;
  const t = createTranslator(locales.en ?? {});
  const passwordRequired = async (gymId: string) => options.config.tenancy === 'single' && passwordLogin(options.config, await options.smtpConfigured(gymId));
  return {
    passwordRequired,
    async resetPassword(actor: Actor, householdId: string, householdUserId: string, newPassword: string) {
      if (!await passwordRequired(actor.gymId)) throw new AppError('forbidden', 'Password login is disabled');
      const where = and(eq(householdUsers.id, householdUserId), eq(householdUsers.householdId, householdId));
      const [login] = await scope(actor.gymId, tx => tx.select().from(householdUsers).where(where));
      if (!login) notFound();
      await accounts.resetPassword({ gymId: actor.gymId, userId: login.userId, actorUserId: actor.userId, newPassword, clock: actor.clock,
        authorize: async tx => {
          if (!(await tx.select().from(householdUsers).where(and(where, eq(householdUsers.userId, login.userId))).for('update'))[0]) notFound();
          await assertCanResetPassword(tx, { gymId: actor.gymId, actorUserId: actor.userId, targetUserId: login.userId });
        } });
      return { data: null };
    },
    /** Issues a token for a household login that is created only on acceptance, so an invitation grants nothing by itself. */
    async invite(actor: Actor, householdId: string, raw: PortalInvitationRequest, origin: string) {
      const input = portalInvitationRequestSchema.parse(raw);
      const mailer = input.delivery === 'email' ? await options.mailer(actor.gymId) : null;
      if (input.delivery === 'email' && !mailer) throw new AppError('unavailable', 'Email delivery is not configured');
      const url = new URL('/portal/claim', origin);
      if (!['http:', 'https:'].includes(url.protocol)) throw new AppError('invalid_request', 'Invalid gym origin');
      let result: { token: string; invitation: PortalInvitationBinding & { expiresAt: Date } } | undefined;
      await accounts.provisionUser(actor.gymId, input.email, input.email, actor.clock, async (tx, userId) => {
        const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, actor.userId));
        if (!canStaff(roles.map(row => row.role as StaffRole), 'portal_access.manage')) notFound();
        await refuseStaff(tx, userId);
        await assertPortalLoginTarget(tx, householdId, input.memberId ?? null, input.scope, actor.clock, actor.timezone);
        if ((await tx.select({ id: householdUsers.id }).from(householdUsers).where(and(eq(householdUsers.householdId, householdId), eq(householdUsers.userId, userId))))[0])
          throw new AppError('conflict', 'Portal login already linked');
        if (input.memberId && (await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.memberId, input.memberId)))[0])
          throw new AppError('conflict', 'Portal login already linked');
        const binding = { userId, householdId, scope: input.scope, memberId: input.memberId ?? null };
        const issued = await store.issue(tx, actor.gymId, binding, actor.clock);
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId, action: 'household_user.invited', targetType: 'household', targetId: householdId,
          after: { userId, scope: binding.scope, memberId: binding.memberId }, occurredAt: actor.clock.now() });
        result = { token: issued.token, invitation: { ...binding, expiresAt: issued.expiresAt } };
      });
      if (!result) throw new AppError('internal', 'Invitation creation failed');
      url.hash = result.token;
      const invitation = { userId: result.invitation.userId, scope: result.invitation.scope, memberId: result.invitation.memberId, expiresAt: result.invitation.expiresAt.toISOString() };
      if (input.delivery === 'print') return { data: { delivery: 'print' as const, invitation, invitationUrl: url.toString() } };
      const text = t('portal/access:invitationEmail') + '\n' + url.toString();
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const sent = await mailer!.sendEmail({ to: input.email.trim().toLowerCase(), subject: t('portal/access:title'), text, html: '<p>' + escaped + '</p>' });
      if (sent.status !== 'sent') throw new AppError('unavailable', 'Invitation was not delivered');
      return { data: { delivery: 'email' as const, invitation } };
    },
    /** The household's invitations that haven't expired or been accepted; the invitee's address is shown to staff only. */
    async outstanding(actor: Actor, householdId: string) {
      if (!(await scope(actor.gymId, tx => tx.select({ id: households.id }).from(households).where(eq(households.id, householdId))))[0]) notFound();
      const rows = await store.outstanding(actor.gymId, householdId, actor.clock);
      const ids = rows.flatMap(row => row.binding.memberId ? [row.binding.memberId] : []);
      const people = ids.length ? await scope(actor.gymId, tx => tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName })
        .from(members).where(and(inArray(members.id, ids), eq(members.householdId, householdId), isNull(members.anonymizedAt)))) : [];
      const names = new Map(people.map(member => [member.id, `${member.firstName} ${member.lastName}`]));
      return { data: rows.map(row => {
        const person = row.binding.memberId ? names.get(row.binding.memberId) : undefined;
        return { id: row.id, scope: row.binding.scope, memberId: row.binding.memberId, memberName: person ?? null,
          email: row.email, expiresAt: row.expiresAt.toISOString() };
      }) };
    },
    /** Withdraws an invitation before it expires. Accepting it afterwards fails, whether the invitee holds the link or a claim code.
     * Like `invite`, it checks the actor's role again in its own transaction. */
    async revokeInvitation(actor: Actor, householdId: string, invitationId: string) {
      await store.revoke({ gymId: actor.gymId, householdId, invitationId, clock: actor.clock }, async (tx, binding) => {
        const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, actor.userId));
        if (!canStaff(roles.map(row => row.role as StaffRole), 'portal_access.manage')) notFound();
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId, action: 'household_user.invitation_revoked', targetType: 'household', targetId: householdId,
          before: { userId: binding.userId, scope: binding.scope, memberId: binding.memberId }, occurredAt: actor.clock.now() });
      });
      return { data: null };
    },
    /** Password mode: the password proves the account and the login is created at once.
     * Passwordless: email or print alike, a login link goes to the invited address and the login is created on its callback. */
    async accept(gymId: string, raw: unknown, clock: Clock, timezone = 'UTC') {
      const input = portalClaimRequestSchema.parse(raw), passwordMode = await passwordRequired(gymId);
      const consume = async (tx: Transaction, binding: PortalInvitationBinding) => {
        await refuseStaff(tx, binding.userId);
        await assertPortalLoginTarget(tx, binding.householdId, binding.memberId, binding.scope, clock, timezone);
        const login = await grant(tx, gymId, binding, clock);
        await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: binding.userId, action: 'household_user.claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
      };
      if (passwordMode) {
        await store.accept({ gymId, token: input.token, password: input.password, passwordMode, clock }, consume);
        return { data: { status: 'claimed' as const } };
      }
      if (input.password !== undefined) throw new AppError('forbidden', 'Password login is disabled');
      const sender = options.loginLink, invitation = await store.inspect(gymId, input.token, clock);
      // Refuse protected accounts before sending anything; completion checks again.
      await scope(gymId, tx => refuseStaff(tx, invitation.binding.userId));
      const expiresAt = new Date(Math.min(invitation.expiresAt.getTime(), clock.now().getTime() + claimLifetime));
      await sender({ gymId, email: invitation.email, claim: codes.seal({ kind: 'invitation', gymId, userId: invitation.binding.userId, invitationId: invitation.invitationId, expiresAt }) });
      return { data: { status: 'email_sent' as const } };
    },
    /** A verified onboarding bearer grants this household only; no caller supplies a household ID. */
    async claimOnboarding(gymId: string, linkId: string, raw: unknown, clock: Clock) {
      const input = portalOnboardingClaimRequestSchema.parse(raw);
      try { await householdScope({ kind: 'signed_link', gymId, linkId, now: clock.now() }, queries => queries.members()); }
      catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
      const passwordMode = await passwordRequired(gymId);
      if (passwordMode && !input.password) throw new AppError('invalid_request', 'Password required');
      if (!passwordMode && input.password !== undefined) throw new AppError('forbidden', 'Password login is disabled');
      if (passwordMode) {
        // The account's password proves it: a new account sets one, an existing one must match.
        await accounts.createPasswordUser(gymId, input.email, input.email, input.password!, clock, async (tx, userId) => {
          await refuseStaff(tx, userId);
          const link = await lockOnboardingLink(tx, linkId, clock);
          await assertPortalLoginTarget(tx, link.householdId, null, 'payer', clock);
          const login = await grant(tx, gymId, { userId, householdId: link.householdId, scope: 'payer', memberId: null }, clock);
          await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: 'household_user.onboarding_claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
        });
        return { data: { status: 'claimed' as const } };
      }
      // Passwordless: nothing is linked until the address owner signs in through the emailed link.
      const sender = options.loginLink;
      let expiresAt = new Date(clock.now().getTime() + claimLifetime);
      const user = await accounts.provisionUser(gymId, input.email, input.email, clock, async (tx, userId) => {
        await refuseStaff(tx, userId);
        const link = await lockOnboardingLink(tx, linkId, clock);
        await assertPortalLoginTarget(tx, link.householdId, null, 'payer', clock);
        if (link.expiresAt < expiresAt) expiresAt = link.expiresAt;
      });
      await sender({ gymId, email: input.email.trim().toLowerCase(), claim: codes.seal({ kind: 'onboarding', gymId, userId: user.id, linkId, expiresAt }) });
      return { data: { status: 'email_sent' as const } };
    },
    /** The login link's callback: the signed-in user completes the claim the code names, if it was issued to them. */
    async completeClaim(gymId: string, userId: string, raw: unknown, clock: Clock, timezone = 'UTC') {
      const input = portalClaimCompletionRequestSchema.parse(raw), claim = codes.open(input.claim, clock.now());
      if (!claim || claim.gymId !== gymId || claim.userId !== userId) notFound();
      let householdId: string | undefined;
      if (claim.kind === 'invitation') {
        await store.redeem({ gymId, invitationId: claim.invitationId, userId, clock }, async (tx, binding) => {
          await refuseStaff(tx, userId);
          await assertPortalLoginTarget(tx, binding.householdId, binding.memberId, binding.scope, clock, timezone);
          const login = await grant(tx, gymId, binding, clock);
          await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: 'household_user.claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
          householdId = binding.householdId;
        });
      } else {
        await scope(gymId, async tx => {
          await refuseStaff(tx, userId);
          const link = await lockOnboardingLink(tx, claim.linkId, clock);
          await assertPortalLoginTarget(tx, link.householdId, null, 'payer', clock, timezone);
          const login = await grant(tx, gymId, { userId, householdId: link.householdId, scope: 'payer', memberId: null }, clock);
          await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: 'household_user.onboarding_claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
          householdId = link.householdId;
        });
      }
      return householdId!;
    },
  };
}
export type PortalInvitationService = ReturnType<typeof createPortalInvitationService>;

export const portalInvitationExpiryJob = 'members.portal-invitations.expire';
/** Each gym's expired portal invitations are deleted hourly, with any invitee identity left holding nothing (no account,
 * link, role, history or other invitation), so it can no longer sign in to a session without access. The same run deletes the
 * install's other expired verification rows, which Better Auth no longer cleans up itself. The runtime registers it. */
export function createPortalInvitationExpiryJobs(store: Pick<PortalInvitationStore, 'expire' | 'sweepExpired'> = createPortalInvitationStore()): readonly JobRegistration[] {
  return [{ id: portalInvitationExpiryJob, cron: '53 * * * *', async handler(_payload, context) {
    await store.expire(context.gymId, context.clock);
    await store.sweepExpired(context.clock);
  } }];
}
