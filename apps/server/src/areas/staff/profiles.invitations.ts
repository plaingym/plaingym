// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { staffRoles, staffProfiles, writeAudit } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { InviteStaffRequest, InviteStaffResponse } from '@plaingym/shared/contracts';
import { z } from '@hono/zod-openapi';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createInvitationStore, invitationTokenSchema } from '../../infra/auth/invitations.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';
import { SmtpEmail, type Email } from '../../infra/email/index.js';
import type { SmtpResolver } from '../settings/smtp.js';
import { renderStaffInvitation } from '../../emails/staff/profiles.js';
import { assertStaffManager, staffAudit, staffRoleRecord, type StaffActor } from './profiles.js';

/** TODO(CCR T11): move the acceptance request and its public route into shared contracts. */
export const acceptStaffInvitationSchema = z.strictObject({
  token: invitationTokenSchema, name: z.string().trim().min(1).max(200), password: z.string().min(12).max(128).optional(),
});
export type AcceptStaffInvitationRequest = z.input<typeof acceptStaffInvitationSchema>;
export interface StaffInvitationOptions {
  readonly config: AuthConfig;
  smtpConfigured(gymId: string): Promise<boolean>;
  /** The gym's sender (its own SMTP, the install fallback, or the demo outbox), or null when it has none. */
  mailer(gymId: string): Email | null | Promise<Email | null>;
  readonly database?: Parameters<typeof createAccountService>[1];
}
/** Sends through the gym's SMTP settings, falling back to the install's. */
export function smtpMailer(smtp: SmtpResolver) {
  return async (gymId: string): Promise<Email | null> => {
    const config = await smtp.config(gymId);
    return config ? new SmtpEmail(config) : null;
  };
}
export function createStaffInvitationService(options: StaffInvitationOptions) {
  const accounts = createAccountService(options.config, options.database), store = createInvitationStore(options.database);
  const t = createTranslator(locales.en ?? {});
  async function passwordRequired(gymId: string) {
    return options.config.tenancy === 'single' && passwordLogin(options.config, await options.smtpConfigured(gymId));
  }
  return {
    passwordRequired,
    async inviteStaff(actor: StaffActor, input: InviteStaffRequest, origin: string): Promise<InviteStaffResponse> {
      assertNoTransaction('staff.inviteStaff');
      if (!['admin', 'coach', 'front_desk'].includes(input.role)) throw new AppError('forbidden', 'Owner assignment is not permitted');
      const mailer = input.delivery === 'email' ? await options.mailer(actor.gymId) : null;
      if (input.delivery === 'email' && !mailer) throw new AppError('unavailable', 'Staff invitations require SMTP for email delivery');
      const url = new URL('/staff-invitation', origin);
      if (!['https:', 'http:'].includes(url.protocol)) throw new AppError('invalid_request', 'Invalid gym origin');
      const email = input.email.trim().toLowerCase();
      let result: { staffRole: InviteStaffResponse['data']['staffRole']; token: string } | undefined;
      await accounts.provisionUser(actor.gymId, email, email, actor.clock, async (tx, userId) => {
        await assertStaffManager(tx, actor.actorUserId);
        const [row] = await tx.insert(staffRoles).values({ gymId: actor.gymId, userId, role: input.role, createdAt: actor.clock.now() }).onConflictDoNothing().returning();
        const current = row ?? (await tx.select().from(staffRoles).where(eq(staffRoles.userId, userId)))[0];
        if (!current || current.role !== input.role) throw new AppError('conflict', 'Account already has a different staff role');
        const binding = { userId, staffRoleId: current.id, role: input.role, revision: current.revision };
        // Only a still-pending invitation can be resent; accepted staff are never reinvited.
        if (!row && !await store.outstanding(tx, binding)) throw new AppError('conflict', 'Account is already staff');
        if (row) await staffAudit(tx, actor, 'staff.role_granted', 'staff_role', row.id);
        const token = await store.issue(tx, actor.gymId, binding, actor.clock);
        await staffAudit(tx, actor, 'staff.invited', 'staff_role', current.id);
        result = { staffRole: staffRoleRecord(current), token };
      });
      if (!result) throw new AppError('internal', 'Invitation creation failed');
      // Fragments keep the bearer token out of request URLs, access logs and referrers.
      url.hash = result.token;
      if (input.delivery === 'print') return { data: { delivery: 'print', staffRole: result.staffRole, invitationUrl: url.toString() } };
      const sent = await mailer!.sendEmail({ to: email, ...renderStaffInvitation(url.toString(), t) });
      if (sent.status !== 'sent') throw new AppError('unavailable', 'Staff invitation was not delivered');
      return { data: { delivery: 'email', staffRole: result.staffRole } };
    },
    async acceptInvitation(gymId: string, raw: AcceptStaffInvitationRequest, clock: Clock) {
      const input = acceptStaffInvitationSchema.parse(raw);
      await store.accept({ gymId, token: input.token, password: input.password, passwordMode: await passwordRequired(gymId), clock }, async (tx, binding) => {
        const [role] = await tx.select().from(staffRoles).where(eq(staffRoles.id, binding.staffRoleId)).for('update');
        if (!role || role.userId !== binding.userId || role.role !== binding.role || role.revision !== binding.revision)
          throw new AppError('not_found', 'Invitation is invalid or expired');
        // Install-wide identity names are left intact; gym presentation belongs to staff profiles.
        await tx.insert(staffProfiles).values({ gymId, userId: binding.userId, displayName: input.name, createdAt: clock.now() }).onConflictDoNothing();
        await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: binding.userId, action: 'staff.invitation_accepted', targetType: 'staff_role', targetId: role.id, occurredAt: clock.now() });
      });
      return { data: null };
    },
  };
}
export type StaffInvitationService = ReturnType<typeof createStaffInvitationService>;
