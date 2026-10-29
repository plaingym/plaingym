// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { logError } from '../../core/log.js';
import type { RequestContext } from '../../core/context.js';
import { createMembersService, type MembersService } from './members.js';
import { createMemberPhotoService, type MemberUploads } from './photos.js';
import type { HouseholdPinSecret } from './pin.js';
import type { Jobs } from '../../infra/jobs/index.js';
import { promoteWaitlist } from '../bookings/bookings.js';
import { detachJob } from '../billing/payments.mutations.js';

function mutation(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) throw new AppError('not_found', 'Resource not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
function jsonRoute(contract: c.EndpointContract, handler: (context: RequestContext, params: Record<string, string>, query: unknown, body: unknown) => Promise<unknown>) {
  const params = contract.params instanceof z.ZodObject ? contract.params : undefined;
  const query = contract.query instanceof z.ZodObject ? contract.query : undefined;
  return route({ ...contract, middleware: bodyLimit({ maxSize: 720_000, onError: () => { throw new AppError('invalid_request', 'Request too large'); } }), request: {
    ...(params ? { params } : {}), ...(query ? { query } : {}),
    ...(contract.body ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}),
  }, responses: { 200: { description: 'Member management response', content: { 'application/json': { schema: contract.response } } } } }, async (ctx) => {
    const context = ctx.get('context'); mutation(context);
    const result = await handler(context, ctx.req.param(), ctx.req.query(), contract.body ? await ctx.req.json() : undefined);
    ctx.header('Cache-Control', 'no-store');
    return ctx.json(contract.response.parse(result) as { data: unknown }, 200);
  });
}

type ErasureOptions = { clock?: Clock; detachCard?: (gymId: string, processorId: string) => Promise<void>; jobs?: Pick<Jobs, 'enqueue'> };
type Composition = ErasureOptions & { service: MembersService; photos: ReturnType<typeof createMemberPhotoService> | undefined; uploadsFor?: MemberUploads };
let configured: Composition | undefined;
/** Runtime supplies the gym key for household PINs and file storage for photos before serving requests. */
export function configureMembers(options: ErasureOptions & { pinSecret: HouseholdPinSecret; uploadsFor: MemberUploads; clock?: Clock }) {
  const service = createMembersService({ pinSecret: options.pinSecret, ...(options.clock ? { clock: options.clock } : {}) });
  configured = { ...options, service, photos: createMemberPhotoService(service, options.uploadsFor) };
}
/** Tests pass a service; otherwise routes use the runtime composition, and without one, photos and
 * nonempty PINs fail closed. */
export function createMembersRoutes(service?: MembersService, uploadsFor?: MemberUploads, erasure: ErasureOptions = {}) {
  const fixed: Composition | undefined = service ? { ...erasure, service, ...(uploadsFor ? { uploadsFor } : {}), photos: uploadsFor ? createMemberPhotoService(service, uploadsFor) : undefined } : undefined;
  const fallback: Composition = { service: createMembersService(), photos: undefined };
  const current = () => fixed ?? configured ?? fallback;
  const contracts = c.membersContracts;
  return [
    jsonRoute(contracts.listMembers, async (ctx, _p, q) => current().service.listMembers(ctx.gym.gymId, c.memberListQuerySchema.parse(q))),
    jsonRoute(contracts.getMember, async (ctx, p) => ({ data: await current().service.getMember(ctx.gym.gymId, p.memberId!) })),
    jsonRoute(contracts.createMember, async (ctx, _p, _q, b) => ({ data: await current().service.createMember(mutation(ctx), c.createMemberRequestSchema.parse(b)) })),
    jsonRoute(contracts.updateMember, async (ctx, p, _q, b) => {
      const input = c.updateMemberRequestSchema.parse(b), { service, photos } = current();
      return { data: photos ? await photos.update(mutation(ctx), p.memberId!, input) : await service.updateMember(mutation(ctx), p.memberId!, input) };
    }),
    jsonRoute(contracts.anonymizeMember, async (ctx, p, _q, b) => {
      const { revision } = c.anonymizeMemberRequestSchema.parse(b), { service, uploadsFor, detachCard, jobs } = current();
      const { member, files, revokedCards, freedSessionIds } = await service.eraseMember(mutation(ctx), p.memberId!, { revision });
      for (const sessionId of freedSessionIds) await promoteWaitlist(ctx.gym.gymId, sessionId,
        current().clock ? { clock: current().clock! } : {});
      // Queue every detach before attempting it, so an outage leaves durable retries.
      for (const card of revokedCards) if (jobs) await jobs.enqueue(detachJob, { paymentMethodId: card.id }, {
        gymId: ctx.gym.gymId, timezone: ctx.gym.timezone, idempotencyKey: `detach:${card.id}`, maxAttempts: 12,
      });
      const cleanup = await Promise.allSettled([
        ...revokedCards.map(async card => {
          if (!detachCard) throw new AppError('unavailable', 'Card removal is not configured');
          try { await detachCard(ctx.gym.gymId, card.processorId); }
          catch (error) {
            // The erasure has committed and the queued job retries the detach; without a queue, report it.
            if (!jobs) throw error;
            logError('members.erasure.detach_failed', { gymId: ctx.gym.gymId, memberId: p.memberId!, paymentMethodId: card.id });
          }
        }),
        ...files.map(async key => {
          if (!uploadsFor) throw new AppError('unavailable', 'Photo storage is not configured');
          await (await uploadsFor(ctx.gym.gymId)).markDeleted(key);
        }),
      ]);
      for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
      return { data: member };
    }),
    jsonRoute(contracts.getMedicalNotes, async (ctx, p) => ({ data: await current().service.getMedicalNotes(ctx.gym.gymId, p.memberId!) })),
    jsonRoute(contracts.updateMedicalNotes, async (ctx, p, _q, b) => ({ data: await current().service.updateMedicalNotes(mutation(ctx), p.memberId!, c.updateMemberMedicalNotesRequestSchema.parse(b)) })),
    jsonRoute(contracts.listHouseholds, async (ctx, _p, q) => current().service.listHouseholds(ctx.gym.gymId, c.householdListQuerySchema.parse(q))),
    jsonRoute(contracts.getHousehold, async (ctx, p) => ({ data: await current().service.getHousehold(ctx.gym.gymId, p.householdId!) })),
    jsonRoute(contracts.createHousehold, async (ctx, _p, _q, b) => ({ data: await current().service.createHousehold(mutation(ctx), c.createHouseholdRequestSchema.parse(b)) })),
    jsonRoute(contracts.updateHousehold, async (ctx, p, _q, b) => ({ data: await current().service.updateHousehold(mutation(ctx), p.householdId!, c.updateHouseholdRequestSchema.parse(b)) })),
    jsonRoute(contracts.deleteHousehold, async (ctx, p, _q, b) => { await current().service.deleteHousehold(mutation(ctx), p.householdId!, c.deleteMemberRecordRequestSchema.parse(b).revision); return { data: null }; }),
    jsonRoute(contracts.getHouseholdBilling, async (ctx, p) => ({ data: await current().service.getHouseholdBilling(ctx.gym.gymId, p.householdId!) })),
    jsonRoute(contracts.updateHouseholdBilling, async (ctx, p, _q, b) => ({ data: await current().service.updateHouseholdBilling(mutation(ctx), p.householdId!, c.updateHouseholdBillingSettingsRequestSchema.parse(b)) })),
    jsonRoute(contracts.setHouseholdPin, async (ctx, p, _q, b) => ({ data: await current().service.setHouseholdPin(mutation(ctx), p.householdId!, c.setHouseholdPinRequestSchema.parse(b)) })),
    jsonRoute(contracts.listTags, async (ctx, _p, q) => current().service.listTags(ctx.gym.gymId, c.paginationSchema.parse(q))),
    jsonRoute(contracts.createTag, async (ctx, _p, _q, b) => ({ data: await current().service.createTag(mutation(ctx), c.createMemberTagRequestSchema.parse(b)) })),
    jsonRoute(contracts.updateTag, async (ctx, p, _q, b) => ({ data: await current().service.updateTag(mutation(ctx), p.tagId!, c.updateMemberTagRequestSchema.parse(b)) })),
    jsonRoute(contracts.deleteTag, async (ctx, p, _q, b) => { await current().service.deleteTag(mutation(ctx), p.tagId!, c.deleteMemberRecordRequestSchema.parse(b).revision); return { data: null }; }),
    jsonRoute(contracts.addTag, async (ctx, p, _q, b) => ({ data: await current().service.addTag(mutation(ctx), p.memberId!, c.addMemberTagRequestSchema.parse(b)) })),
    jsonRoute(contracts.removeTag, async (ctx, p) => { await current().service.removeTag(mutation(ctx), p.memberId!, p.tagId!); return { data: null }; }),
    jsonRoute(contracts.listMemberTags, async (ctx, p) => ({ data: await current().service.listMemberTags(ctx.gym.gymId, p.memberId!) })),
    jsonRoute(contracts.uploadPhoto, async (ctx, p, _q, b) => {
      const input = c.uploadMemberPhotoRequestSchema.parse(b);
      const photos = current().photos;
      if (!photos) throw new AppError('unavailable', 'Photo storage is not configured');
      return { data: await photos.upload(mutation(ctx), p.memberId!, input.revision, Buffer.from(input.base64, 'base64'), input.contentType) };
    }),
    // Endpoint contracts describe JSON responses, so the binary photo read is declared here.
    route({ method: 'get', path: '/api/members/{memberId}/photo', permission: contracts.getMember.permission,
      request: { params: c.memberParamsSchema }, responses: { 200: { description: 'Member photo', content: { 'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) } } } },
    }, async (ctx) => {
      const context = ctx.get('context'); mutation(context);
      const photos = current().photos;
      if (!photos) throw new AppError('unavailable', 'Photo storage is not configured');
      const result = await photos.read(context.gym.gymId, ctx.req.valid('param').memberId);
      return new Response(result.stream, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }),
  ];
}
export const routes = createMembersRoutes();
