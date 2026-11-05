// SPDX-License-Identifier: AGPL-3.0-only
import { canMember } from '@plaingym/shared';
import type { RouteConfig, RouteHandler } from '@hono/zod-openapi';
import { portalHouseholdHeader, portalHouseholdHeadersSchema } from '@plaingym/shared/contracts';
import { route, type PermissionMiddleware, type RouteAuthorization, type RouteRegistration } from '../../core/registry.js';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import type { RequestContext, RequestEnvironment } from '../../core/context.js';
import { notFound } from '../../core/interfaces/common.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';

export function portalIdentity(context: RequestContext): PortalIdentity {
  const { principal, gym } = context;
  if (principal.kind !== 'member' || principal.scope.gymId !== gym.gymId) notFound();
  return { gymId: gym.gymId, userId: principal.userId, householdId: principal.scope.householdId };
}
const portalRoutes = new WeakSet<RouteRegistration>();
export const isPortalRoute = (registration: RouteRegistration) => portalRoutes.has(registration);
type AnswerSchema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
const contractFor = (definition: RouteConfig, status: number) =>
  (definition.responses as Record<number, { content: { 'application/json': { schema: AnswerSchema } } }>)[status]!.content['application/json'].schema;
/** The only place that stamps successful portal answers. Errors keep their normal envelope. */
export function portalRoute<const C extends RouteConfig>(definition: C & RouteAuthorization,
  handler: (...args: Parameters<RouteHandler<C, RequestEnvironment>>) => Response | Promise<Response>): RouteRegistration {
  const documented = { ...definition,
    ...(definition.method === 'get' ? {} : { request: { ...definition.request, headers: portalHouseholdHeadersSchema } }),
  } as C & RouteAuthorization;
  const wrapped = async (...args: Parameters<RouteHandler<C, RequestEnvironment>>) => {
    const [c] = args, response = await handler(...args);
    if (!response.ok) return response;
    const principal = c.get('context').principal;
    if (principal.kind !== 'member') notFound();
    const body = await response.json() as Record<string, unknown>;
    // Handlers return plain Responses, so this is the one place an answer is held to its contract before it leaves.
    const answer = contractFor(definition, response.status).safeParse({ ...body, householdId: principal.scope.householdId });
    if (!answer.success) throw new Error(`The answer to ${definition.method} ${definition.path} doesn't match its contract`);
    return new Response(JSON.stringify(answer.data), response);
  };
  // The wrapper supplies the household required by the documented answer.
  const registration = route(documented, wrapped as RouteHandler<C, RequestEnvironment>);
  portalRoutes.add(registration);
  return registration;
}
/** Mount portal routes with this middleware; cached/request-supplied roles never authorize a request. */
export function createPortalAuthorization(households: MemberHouseholdContext = createMemberHouseholdContext()): PermissionMiddleware {
  return permission => permission.kind !== 'member' ? authorize(permission) : async (ctx, next) => {
    const current = ctx.get('context');
    const scope = await households.resolve(portalIdentity(current));
    const expected = ctx.req.header(portalHouseholdHeader);
    if ((expected !== undefined || !['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) && expected !== scope.householdId) {
      ctx.header('Cache-Control', 'no-store');
      ctx.header(portalHouseholdHeader, scope.householdId);
      return ctx.json({ error: { code: 'conflict', message: 'The open household has changed.' }, requestId: current.requestId }, 409);
    }
    if (!canMember(scope.role, permission.capability)) notFound();
    ctx.set('context', { ...current, principal: { kind: 'member', userId: scope.userId, scope } });
    await next();
  };
}
