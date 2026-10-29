// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, forHousehold, householdUsers, signedLinks, staffRoles, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, canStaff, createTranslator, type Clock, type StaffRole } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { householdUserSchema, portalClaimRequestSchema, portalInvitationRequestSchema, portalOnboardingClaimRequestSchema, type PortalInvitationRequest } from '@plaingym/shared/contracts';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import type { Email } from '../../infra/email/index.js';
import { notFound } from '../../core/interfaces/common.js';
import { assertCanResetPassword } from '../staff/auth.reset.js';
import { assertPortalLoginTarget } from './household-users.js';

type Actor = { gymId: string; userId: string; clock: Clock; timezone?: string };
export interface PortalInvitationOptions {
  config: AuthConfig;
  smtpConfigured(gymId: string): Promise<boolean>;
  mailer(gymId: string): Email | null | Promise<Email | null>;
  database?: Parameters<typeof createAccountService>[1];
  householdScope?: typeof forHousehold;
  scope?: typeof forGym;
}
const bindingFor = (login: typeof householdUsers.$inferSelect) => ({ userId: login.userId, householdUserId: login.id, householdId: login.householdId, scope: login.scope as 'payer' | 'member', memberId: login.memberId });
export function createPortalInvitationService(options: PortalInvitationOptions) {
  const accounts = createAccountService(options.config, options.database), store = createPortalInvitationStore(options.database);
  const householdScope = options.householdScope ?? forHousehold;
  const t = createTranslator(locales.en ?? {});
  const passwordRequired = async (gymId: string) => options.config.tenancy === 'single' && passwordLogin(options.config, await options.smtpConfigured(gymId));
  return {
    passwordRequired,
    async resetPassword(actor: Actor, householdId: string, householdUserId: string, newPassword: string) {
      if (!await passwordRequired(actor.gymId)) throw new AppError('forbidden', 'Password login is disabled');
      const where = and(eq(householdUsers.id, householdUserId), eq(householdUsers.householdId, householdId));
      const [login] = await (options.scope ?? forGym)(actor.gymId, tx => tx.select().from(householdUsers).where(where));
      if (!login) notFound();
      await accounts.resetPassword({ gymId: actor.gymId, userId: login.userId, actorUserId: actor.userId, newPassword, clock: actor.clock,
        authorize: async tx => {
          if (!(await tx.select().from(householdUsers).where(and(where, eq(householdUsers.userId, login.userId))).for('update'))[0]) notFound();
          await assertCanResetPassword(tx, { gymId: actor.gymId, actorUserId: actor.userId, targetUserId: login.userId });
        } });
      return { data: null };
    },
    async invite(actor: Actor, householdId: string, raw: PortalInvitationRequest, origin: string) {
      const input = portalInvitationRequestSchema.parse(raw);
      const mailer = input.delivery === 'email' ? await options.mailer(actor.gymId) : null;
      if (input.delivery === 'email' && !mailer) throw new AppError('unavailable', 'Email delivery is not configured');
      const url = new URL('/portal/claim', origin);
      if (!['http:', 'https:'].includes(url.protocol)) throw new AppError('invalid_request', 'Invalid gym origin');
      let result: { token: string; login: ReturnType<typeof householdUserSchema.parse> } | undefined;
      await accounts.provisionUser(actor.gymId, input.email, input.email, actor.clock, async (tx, userId) => {
        const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, actor.userId));
        if (!canStaff(roles.map(row => row.role as StaffRole), 'portal_access.manage')) notFound();
        if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)))[0]) throw new AppError('forbidden', 'Protected account');
        await assertPortalLoginTarget(tx, householdId, input.memberId ?? null, input.scope, actor.clock, actor.timezone);
        const [created] = await tx.insert(householdUsers).values({ gymId: actor.gymId, householdId, userId, scope: input.scope, memberId: input.memberId ?? null, createdAt: actor.clock.now() }).onConflictDoNothing().returning();
        const login = created ?? (await tx.select().from(householdUsers).where(and(eq(householdUsers.householdId, householdId), eq(householdUsers.userId, userId))).for('update'))[0];
        if (!login || login.scope !== input.scope || login.memberId !== (input.memberId ?? null)) throw new AppError('conflict', 'Portal login already linked');
        const binding = bindingFor(login);
        if (!created && !await store.outstanding(tx, binding)) throw new AppError('conflict', 'Portal login already claimed');
        const token = await store.issue(tx, actor.gymId, binding, actor.clock);
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId, action: 'household_user.invited', targetType: 'household_user', targetId: login.id, occurredAt: actor.clock.now() });
        result = { token, login: householdUserSchema.parse({ id: login.id, householdId, userId, scope: login.scope, memberId: login.memberId, createdAt: login.createdAt.toISOString() }) };
      });
      if (!result) throw new AppError('internal', 'Invitation creation failed');
      url.hash = result.token;
      if (input.delivery === 'print') return { data: { delivery: 'print' as const, login: result.login, invitationUrl: url.toString() } };
      const text = t('portal/access:invitationEmail') + '\n' + url.toString();
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const sent = await mailer!.sendEmail({ to: input.email.trim().toLowerCase(), subject: t('portal/access:title'), text, html: '<p>' + escaped + '</p>' });
      if (sent.status !== 'sent') throw new AppError('unavailable', 'Invitation was not delivered');
      return { data: { delivery: 'email' as const, login: result.login } };
    },
    async accept(gymId: string, raw: unknown, clock: Clock, timezone = 'UTC') {
      const input = portalClaimRequestSchema.parse(raw);
      await store.accept({ gymId, token: input.token, password: input.password, passwordMode: await passwordRequired(gymId), clock }, async (tx, binding) => {
        if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, binding.userId)))[0]) throw new AppError('forbidden', 'Protected account');
        const [login] = await tx.select().from(householdUsers).where(eq(householdUsers.id, binding.householdUserId)).for('update');
        if (!login || JSON.stringify(bindingFor(login)) !== JSON.stringify(binding)) notFound();
        await assertPortalLoginTarget(tx, binding.householdId, binding.memberId, binding.scope, clock, timezone);
        await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: binding.userId, action: 'household_user.claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
      });
      return { data: null };
    },
    /** A verified onboarding bearer grants this household only; no caller supplies a household ID. */
    async claimOnboarding(gymId: string, linkId: string, raw: unknown, clock: Clock) {
      const input = portalOnboardingClaimRequestSchema.parse(raw);
      try { await householdScope({ kind: 'signed_link', gymId, linkId, now: clock.now() }, queries => queries.members()); }
      catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
      const passwordMode = await passwordRequired(gymId);
      if (passwordMode && !input.password) throw new AppError('invalid_request', 'Password required');
      if (!passwordMode && input.password !== undefined) throw new AppError('forbidden', 'Password login is disabled');
      const provision = async (tx: Transaction, userId: string) => {
        if ((await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, userId)))[0]) throw new AppError('forbidden', 'Protected account');
        const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
        if (!link || link.purpose !== 'onboarding' || link.usedAt || link.revokedAt || link.expiresAt <= clock.now()) notFound();
        await assertPortalLoginTarget(tx, link.householdId, null, 'payer', clock);
        const [created] = await tx.insert(householdUsers).values({ gymId, householdId: link.householdId, userId, scope: 'payer', createdAt: clock.now() }).onConflictDoNothing().returning();
        const login = created ?? (await tx.select().from(householdUsers).where(and(eq(householdUsers.householdId, link.householdId), eq(householdUsers.userId, userId))))[0];
        if (!login || login.scope !== 'payer') throw new AppError('conflict', 'Portal login already linked');
        await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: userId, action: 'household_user.onboarding_claimed', targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
      };
      if (passwordMode) await accounts.createPasswordUser(gymId, input.email, input.email, input.password!, clock, provision);
      else await accounts.provisionUser(gymId, input.email, input.email, clock, provision);
      return { data: null };
    },
  };
}
export type PortalInvitationService = ReturnType<typeof createPortalInvitationService>;
