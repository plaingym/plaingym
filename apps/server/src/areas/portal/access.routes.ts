// SPDX-License-Identifier: AGPL-3.0-only
import { membersContracts as contracts, portalAccessContracts } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import type { Context } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { rateLimit } from '../../core/rate-limit.js';
import type { PortalInvitationService } from '../members/household-users.invitations.js';
import { route } from '../../core/registry.js';
import { createHouseholdUsersService } from '../members/household-users.js';
import { createPortalHouseholdChoices } from '../members/household-users.context.js';
import { createPortalSessionStore } from '../../infra/auth/portal-sessions.js';
import { requestSession } from '../../infra/auth/middleware.js';
import { notFound } from '../../core/interfaces/common.js';
import type { RequestContext } from '../../core/context.js';

function actor(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) notFound();
  return { gymId: context.gym.gymId, timezone: context.gym.timezone, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createPortalAccessRoutes(service = createHouseholdUsersService()) {
  const list = contracts.listHouseholdUsers, create = contracts.createHouseholdUser, revoke = contracts.revokeHouseholdUser;
  const details = portalAccessContracts.logins;
  return [
    route({ ...details, request: { params: details.params, query: details.query }, responses: { 200: { description: 'Household logins with email addresses', content: { 'application/json': { schema: details.response } } } } }, async ctx => {
      const identity = actor(ctx.get('context')), { householdId } = ctx.req.valid('param');
      const [result, emails, awaitingConfirmation] = await Promise.all([service.list(identity.gymId, householdId, ctx.req.valid('query')),
        service.loginEmails(identity.gymId, householdId), service.awaitingConfirmation(identity.gymId, householdId)]);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ ...result, data: result.data.map(row => { const email = emails.find(email => email.id === row.id)?.email; return { ...row, ...(email ? { email } : {}) }; }),
        ...(awaitingConfirmation ? { awaitingConfirmation } : {}) }, 200);
    }),
    route({ ...list, request: { params: list.params, query: list.query }, responses: { 200: { description: 'Household logins', content: { 'application/json': { schema: list.response } } } } }, async ctx => {
      const identity = actor(ctx.get('context'));
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(await service.list(identity.gymId, ctx.req.valid('param').householdId, ctx.req.valid('query')), 200);
    }),
    route({ ...create, request: { params: create.params, body: { required: true, content: { 'application/json': { schema: create.body } } } }, responses: { 200: { description: 'Household login created', content: { 'application/json': { schema: create.response } } } } }, async ctx => {
      const result = await service.create(actor(ctx.get('context')), ctx.req.valid('param').householdId, ctx.req.valid('json'));
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ data: result }, 200);
    }),
    route({ ...revoke, request: { params: revoke.params }, responses: { 200: { description: 'Household login revoked', content: { 'application/json': { schema: revoke.response } } } } }, async ctx => {
      const params = ctx.req.valid('param');
      await service.revoke(actor(ctx.get('context')), params.householdId, params.householdUserId);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ data: null }, 200);
    }),
  ];
}
/** Public routes that need a signed-in, gym-bound session of any kind; never a household from the request. */
function signedIn(context: RequestContext) {
  const { principal, gym } = context;
  if (principal.kind === 'member' && principal.scope.gymId === gym.gymId) return { userId: principal.userId, staff: false, householdId: principal.scope.householdId };
  if (principal.kind === 'staff' && principal.gymId === gym.gymId) return { userId: principal.userId, staff: principal.roles.length > 0, householdId: null };
  throw new AppError('unauthenticated', 'Sign in required');
}
/** The picker and header switcher. The choice is stored with the session; the principal loader rechecks it on every request. */
export function createPortalHouseholdRoutes(options: { choices?: ReturnType<typeof createPortalHouseholdChoices>; sessions?: ReturnType<typeof createPortalSessionStore> } = {}) {
  const choices = options.choices ?? createPortalHouseholdChoices(), sessions = options.sessions ?? createPortalSessionStore();
  const list = portalAccessContracts.households, select = portalAccessContracts.selectHousehold;
  return [
    route({ ...list, responses: { 200: { description: 'Households this login may open', content: { 'application/json': { schema: list.response } } } } }, async ctx => {
      const context = ctx.get('context'), user = signedIn(context);
      ctx.header('Cache-Control', 'no-store'); ctx.header('Vary', 'Cookie');
      return ctx.json({ data: { current: user.householdId, households: await choices.list(context.gym.gymId, user.userId) } }, 200);
    }),
    route({ ...select, middleware: rateLimit({ limit: 30 }), request: { body: { required: true, content: { 'application/json': { schema: select.body } } } }, responses: { 200: { description: 'Household chosen for this session', content: { 'application/json': { schema: select.response } } } } }, async ctx => {
      const context = ctx.get('context'), user = signedIn(context), session = requestSession(ctx.req.raw);
      // Staff identities keep their staff principal and never open a household.
      if (user.staff) notFound();
      if (!session || session.userId !== user.userId) throw new AppError('unauthenticated', 'Sign in required');
      await sessions.select(context.gym.gymId, session, ctx.req.valid('json').householdId, context.clock);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ data: null }, 200);
    }),
  ];
}
type InvitationOptions = { service: PortalInvitationService; origin(context: Context<RequestEnvironment>): string };
let configured: InvitationOptions | undefined;
export function configurePortalAccess(options: InvitationOptions) { configured = options; }
export function createPortalInvitationRoutes(options?: InvitationOptions, sessions = createPortalSessionStore()) {
  const current = () => options ?? configured ?? (() => { throw new AppError('unavailable', 'Portal invitations are not configured'); })();
  const invite = portalAccessContracts.invite, claim = portalAccessContracts.claim, reset = portalAccessContracts.resetPassword, complete = portalAccessContracts.completeClaim;
  return [
    route({ ...reset, middleware: rateLimit({ limit: 10 }), request: { params: reset.params, body: { required: true, content: { 'application/json': { schema: reset.body } } } }, responses: { 200: { description: 'Portal password reset', content: { 'application/json': { schema: reset.response } } } } }, async ctx => {
      const identity = actor(ctx.get('context')), { clock } = ctx.get('context'), params = ctx.req.valid('param');
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(await current().service.resetPassword({ gymId: identity.gymId, userId: identity.actor.userId, clock }, params.householdId, params.householdUserId, ctx.req.valid('json').newPassword), 200);
    }),
    route({ ...invite, middleware: rateLimit({ limit: 20 }), request: { params: invite.params, body: { required: true, content: { 'application/json': { schema: invite.body } } } }, responses: { 200: { description: 'Portal invitation', content: { 'application/json': { schema: invite.response } } } } }, async ctx => {
      const identity = actor(ctx.get('context')), { clock } = ctx.get('context'), options = current();
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(await options.service.invite({ gymId: identity.gymId, timezone: identity.timezone, userId: identity.actor.userId, clock }, ctx.req.valid('param').householdId, ctx.req.valid('json'), options.origin(ctx)), 200);
    }),
    route({ ...claim, middleware: rateLimit({ limit: 10 }), request: { body: { required: true, content: { 'application/json': { schema: claim.body } } } }, responses: { 200: { description: 'Portal invitation accepted', content: { 'application/json': { schema: claim.response } } } } }, async ctx => {
      const { gym, clock } = ctx.get('context');
      ctx.header('Cache-Control', 'no-store');
      return ctx.json(await current().service.accept(gym.gymId, ctx.req.valid('json'), clock, gym.timezone), 200);
    }),
    route({ ...complete, middleware: rateLimit({ limit: 10 }), request: { body: { required: true, content: { 'application/json': { schema: complete.body } } } }, responses: { 200: { description: 'Portal claim completed', content: { 'application/json': { schema: complete.response } } } } }, async ctx => {
      const context = ctx.get('context'), user = signedIn(context), session = requestSession(ctx.req.raw);
      const householdId = await current().service.completeClaim(context.gym.gymId, user.userId, ctx.req.valid('json'), context.clock, context.gym.timezone);
      // Open the household just claimed; a failure here leaves the claim complete and the picker available.
      if (session?.userId === user.userId) await sessions.select(context.gym.gymId, session, householdId, context.clock).catch(() => undefined);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ data: null }, 200);
    }),
  ];
}
export const routes = [...createPortalAccessRoutes(), ...createPortalInvitationRoutes(), ...createPortalHouseholdRoutes()];
