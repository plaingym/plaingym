// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, like, ne } from 'drizzle-orm';
import { authAccount, authSession, authUser, authVerification, databaseCode, writeAudit, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import { AppError, type Clock, type Translator } from '@plaingym/shared';
import { accountEmailSchema, emailChangeTokenSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { z } from 'zod';
import { logError } from '../../core/log.js';
import type { Email } from '../email/index.js';
import { renderEmailChangeLink, renderEmailChangedNotice } from '../../emails/staff/account.js';
import { consumeAccountAttempt, type SignInRule } from './account-limit.js';
import type { AuthConfig } from './config.js';

/** How long the link sent to the new address stays usable. */
export const emailChangeLifetimeMs = 60 * 60 * 1000;
/** Change requests per login: each sends an email to an address the login typed. */
export const emailChangeLimit: SignInRule = { window: 3600, max: 5 };
/** The page the link opens; it reads the token from the fragment and posts it to the confirm route. */
export const emailChangePagePath = '/account-email';
const prefix = (gymId: string) => `email-change:${gymId}:`;
const identifier = (gymId: string, token: string) => prefix(gymId) + createHash('sha256').update(token).digest('hex');
/** The row's value names the login first, so one login's pending rows are found by prefix. Never holds the token. */
const bindingSchema = z.strictObject({ userId: z.uuid(), sessionId: z.uuid().nullable(), from: z.string(), to: z.string() });
type Binding = z.infer<typeof bindingSchema>;
const pendingOf = (gymId: string, userId: string) => and(like(authVerification.identifier, prefix(gymId) + '%'),
  like(authVerification.value, `{"userId":"${z.uuid().parse(userId)}",%`));
const invalid = () => new AppError('not_found', 'The link is invalid or expired');
const inUse = () => new AppError('conflict', 'Another login uses this address', { newEmail: ['email_in_use'] });
/** `d***@example.com`: enough for the owner of the old address to recognize the change, not to learn the new address. */
export function maskAddress(address: string) {
  const at = address.lastIndexOf('@');
  return at <= 0 ? '***' : address.slice(0, 1) + '***' + address.slice(at);
}

/** The gym's mail and canonical origin for the link; never the request's Host header. Throws when the gym can't send email. */
export type EmailChangeMail = (gymId: string) => Promise<{ origin: string; email: Email; gymName: string; t: Translator }>;
export interface EmailChangeOptions {
  readonly config: Pick<AuthConfig, 'tenancy'>;
  readonly database?: typeof systemDatabase;
  /** Epoch milliseconds for the per-login request limit (default `Date.now`). */
  readonly now?: () => number;
  readonly limit?: SignInRule;
}
export interface AppliedEmailChange { readonly userId: string; readonly from: string; readonly to: string; readonly googleUnlinked: boolean }

/**
 * Sign-in email changes. A signed-in login asks for one; the link goes to the new address, hashed in `auth_verification`
 * under the issuing gym's prefix, for one hour and one use, and the change applies only when it is opened. Applying it
 * verifies the new address, unlinks Google (a Google account was linked for the old address), ends the login's other
 * sessions in the gym, and writes the audit in one transaction; the old address then gets a notice. Only `single` tenancy:
 * in `multi` mode one login's address is shared by every gym it belongs to, and no gym may change it for the others.
 */
export function createEmailChangeService(options: EmailChangeOptions) {
  const database = options.database ?? systemDatabase, now = options.now ?? Date.now, limit = options.limit ?? emailChangeLimit;
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  const single = () => { if (options.config.tenancy !== 'single') throw new AppError('forbidden', 'Sign-in email changes need a single-gym install'); };
  /** Locks the login, refuses an address another login uses, and applies the change with its effects. */
  async function apply(tx: Transaction, input: { gymId: string; userId: string; from: string; to: string; keepSessionId: string | null;
    actorUserId: string | null; clock: Clock }) {
    const [user] = await tx.select({ id: authUser.id, email: authUser.email }).from(authUser).where(eq(authUser.id, input.userId)).for('update');
    if (!user || user.email !== input.from) throw invalid();
    const [taken] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, input.to));
    if (taken) throw inUse();
    // Another login can take the address between the check and the update (its own change, applied at the same moment).
    await tx.update(authUser).set({ email: input.to, emailVerified: true, updatedAt: input.clock.now() }).where(eq(authUser.id, user.id))
      .catch((error: unknown) => { throw databaseCode(error) === '23505' ? inUse() : error; });
    // A Google account links to a login by a matching verified address; the old address's account no longer matches.
    const google = await tx.delete(authAccount).where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, 'google'))).returning({ id: authAccount.id });
    const sessions = and(eq(authSession.gymId, input.gymId), eq(authSession.userId, user.id), ...input.keepSessionId ? [ne(authSession.id, input.keepSessionId)] : []);
    const ended = await tx.delete(authSession).where(sessions).returning({ id: authSession.id });
    await tx.delete(authVerification).where(pendingOf(input.gymId, user.id));
    await writeAudit(tx, { gymId: input.gymId, ...input.actorUserId ? { actorKind: 'user', actorUserId: input.actorUserId } : { actorKind: 'system' },
      action: 'auth.email_changed', targetType: 'user', targetId: user.id, occurredAt: input.clock.now(),
      after: { googleUnlinked: google.length > 0, sessionsEnded: ended.length } });
    return { userId: user.id, from: input.from, to: input.to, googleUnlinked: google.length > 0 };
  }
  /** The old address hears about the change after it commits. A failed notice doesn't undo the change; it is logged. */
  async function notify(gymId: string, applied: AppliedEmailChange, mail?: EmailChangeMail) {
    if (!mail) return;
    try {
      const prepared = await mail(gymId);
      await prepared.email.sendEmail({ to: applied.from, ...renderEmailChangedNotice(maskAddress(applied.to), prepared.gymName, prepared.t) });
    } catch (error) { logError('auth.email_change_notice_failed', { gymId }, error); }
  }
  return {
    /** Changes are possible only in `single` tenancy. */
    tenancy: options.config.tenancy,
    /** What the account page shows about the login itself. Roles and households are the gym's, read by the route. */
    async summary(gymId: string, userId: string, clock: Clock) {
      assertNoTransaction('auth.accountSummary');
      return forGym(gymId, async (tx) => {
        const [user] = await tx.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId));
        if (!user) throw new AppError('unauthenticated', 'Sign in again');
        const accounts = await tx.select({ providerId: authAccount.providerId, password: authAccount.password }).from(authAccount).where(eq(authAccount.userId, userId));
        const [pending] = await tx.select({ value: authVerification.value, expiresAt: authVerification.expiresAt }).from(authVerification)
          .where(and(pendingOf(gymId, userId), gt(authVerification.expiresAt, clock.now()))).orderBy(desc(authVerification.createdAt)).limit(1);
        const binding = pending ? bindingSchema.safeParse(JSON.parse(pending.value)) : undefined;
        return { email: user.email, password: accounts.some(account => account.providerId === 'credential' && Boolean(account.password)),
          googleLinked: accounts.some(account => account.providerId === 'google'),
          pendingEmail: binding?.success && binding.data.from === user.email ? { email: binding.data.to, expiresAt: pending!.expiresAt.toISOString() } : null };
      });
    },
    /**
     * Records the change and sends its link to the new address. Asking again replaces the outstanding link. The caller's
     * session survives the change; the login's other sessions in the gym end when it applies.
     */
    async request(input: { gymId: string; userId: string; sessionId: string | null; newEmail: string; clock: Clock; mail: EmailChangeMail }) {
      assertNoTransaction('auth.requestEmailChange');
      single();
      const to = accountEmailSchema.parse(input.newEmail.trim()).toLowerCase();
      const wait = await consumeAccountAttempt(database(), '/account/email', input.userId, limit, now());
      if (wait !== null) throw new AppError('rate_limited', 'Too many email change requests. Try again later.');
      const mail = await input.mail(input.gymId);
      const token = randomBytes(32).toString('hex'), expiresAt = new Date(input.clock.now().getTime() + emailChangeLifetimeMs);
      const from = await forGym(input.gymId, async (tx) => {
        const [user] = await tx.select({ id: authUser.id, email: authUser.email }).from(authUser).where(eq(authUser.id, input.userId)).for('update');
        if (!user) throw new AppError('unauthenticated', 'Sign in again');
        if (user.email === to) throw new AppError('invalid_request', 'This is already your sign-in email', { newEmail: ['same_email'] });
        const [taken] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, to));
        if (taken) throw inUse();
        await tx.delete(authVerification).where(pendingOf(input.gymId, user.id));
        const value: Binding = { userId: user.id, sessionId: input.sessionId, from: user.email, to };
        await tx.insert(authVerification).values({ identifier: identifier(input.gymId, token), value: JSON.stringify(bindingSchema.parse(value)),
          expiresAt, createdAt: input.clock.now(), updatedAt: input.clock.now() });
        await writeAudit(tx, { gymId: input.gymId, actorKind: 'user', actorUserId: user.id, action: 'auth.email_change_requested',
          targetType: 'user', targetId: user.id, occurredAt: input.clock.now() });
        return user.email;
      });
      const url = new URL(emailChangePagePath, mail.origin);
      url.hash = token;
      try {
        await mail.email.sendEmail({ to, ...renderEmailChangeLink(url.href, mail.gymName, mail.t) });
      } catch (error) {
        // A link nobody received can't be opened; withdraw it, so the page shows no pending change.
        await database().delete(authVerification).where(eq(authVerification.identifier, identifier(input.gymId, token)));
        logError('auth.email_change_link_failed', { gymId: input.gymId }, error);
        throw new AppError('unavailable', 'The confirmation email was not sent');
      }
      return { from, email: to, expiresAt: expiresAt.toISOString() };
    },
    /**
     * Applies the change the token names, in the gym that issued it. A request carrying another login's session is refused,
     * so one household's login can't complete a change for another's. The session that asked for the change stays signed in.
     */
    async confirm(input: { gymId: string; token: string; sessionUserId: string | null; clock: Clock; mail?: EmailChangeMail }) {
      assertNoTransaction('auth.confirmEmailChange');
      single();
      if (!emailChangeTokenSchema.safeParse(input.token).success) throw invalid();
      const key = identifier(input.gymId, input.token);
      const applied = await forGym(input.gymId, async (tx) => {
        const [row] = await tx.select().from(authVerification).where(eq(authVerification.identifier, key)).for('update');
        if (!row || row.expiresAt <= input.clock.now()) throw invalid();
        const binding = bindingSchema.parse(JSON.parse(row.value));
        if (input.sessionUserId && input.sessionUserId !== binding.userId) throw new AppError('forbidden', 'Another login is signed in');
        return apply(tx, { gymId: input.gymId, userId: binding.userId, from: binding.from, to: binding.to, keepSessionId: binding.sessionId,
          actorUserId: binding.userId, clock: input.clock });
      });
      await notify(input.gymId, applied, input.mail);
      return applied;
    },
    /**
     * `gym-app auth change-email`: server access is the proof, as for password recovery, so the change applies at once.
     * `authorize` runs in the transaction after the login is found (the CLI requires a current owner). Every session ends.
     */
    async changeByOperator(input: { gymId: string; from: string; to: string; clock: Clock; authorize(tx: Transaction, userId: string): Promise<void> }) {
      assertNoTransaction('auth.changeEmailByOperator');
      single();
      const from = input.from.trim().toLowerCase(), to = accountEmailSchema.parse(input.to.trim()).toLowerCase();
      if (from === to) throw new AppError('invalid_request', 'The new email is the current one');
      return forGym(input.gymId, async (tx) => {
        const [user] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, from));
        if (!user) throw new AppError('not_found', 'Owner account not found');
        await input.authorize(tx, user.id);
        return apply(tx, { gymId: input.gymId, userId: user.id, from, to, keepSessionId: null, actorUserId: null, clock: input.clock });
      });
    },
  };
}
export type EmailChangeService = ReturnType<typeof createEmailChangeService>;
