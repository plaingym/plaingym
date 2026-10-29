// SPDX-License-Identifier: AGPL-3.0-only
import { membersContracts as contracts, portalAccessContracts } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import type { Context } from 'hono';
import type { RequestEnvironment } from '../../core/context.js';
import { rateLimit } from '../../core/rate-limit.js';
import type { PortalInvitationService } from '../members/household-users.invitations.js';
import { route } from '../../core/registry.js';
import { createHouseholdUsersService } from '../members/household-users.js';
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
      const result = await service.list(identity.gymId, householdId, ctx.req.valid('query'));
      const emails = await service.loginEmails(identity.gymId, householdId);
      ctx.header('Cache-Control', 'no-store');
      return ctx.json({ ...result, data: result.data.map(row => { const email = emails.find(email => email.id === row.id)?.email; return { ...row, ...(email ? { email } : {}) }; }) }, 200);
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
type InvitationOptions = { service: PortalInvitationService; origin(context: Context<RequestEnvironment>): string };
let configured: InvitationOptions | undefined;
export function configurePortalAccess(options: InvitationOptions) { configured = options; }
export function createPortalInvitationRoutes(options?: InvitationOptions) {
  const current = () => options ?? configured ?? (() => { throw new AppError('unavailable', 'Portal invitations are not configured'); })();
  const invite = portalAccessContracts.invite, claim = portalAccessContracts.claim, reset = portalAccessContracts.resetPassword;
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
  ];
}
export const routes = [...createPortalAccessRoutes(), ...createPortalInvitationRoutes()];
