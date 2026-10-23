// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { staffContracts } from '@plaingym/shared/contracts';
import type { Context } from 'hono';
import { route } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { rateLimit } from '../../core/rate-limit.js';
import { createStaffProfileService, type StaffActor } from './profiles.js';
import { acceptStaffInvitationSchema, type StaffInvitationService } from './profiles.invitations.js';
import { createStaffPhotoRoutes, createStaffPhotoService } from './profiles.photos.js';
import type { Uploads } from '../../infra/storage/index.js';
import { invitationPage } from './profiles.accept.js';

function actor(c: Context<RequestEnvironment>): StaffActor {
  const { principal, gym, clock } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  return { gymId: gym.gymId, actorUserId: principal.userId, clock };
}
type Origin = (c: Context<RequestEnvironment>) => string;
type Composition = { service: ReturnType<typeof createStaffProfileService>; invitations: StaffInvitationService; photos: ReturnType<typeof createStaffPhotoService>; origin: Origin };
let configured: Composition | undefined;
function configuration() {
  if (!configured) throw new AppError('unavailable', 'Staff management is not configured');
  return configured;
}
/** Runtime supplies per-gym storage, invitation delivery and the canonical hostname origin. */
export function configureStaffProfiles(options: { invitations: StaffInvitationService; uploadsFor: (gymId: string) => Promise<Uploads>; origin: Origin }) {
  configured = { service: createStaffProfileService(), invitations: options.invitations, photos: createStaffPhotoService(options.uploadsFor), origin: options.origin };
}
export function createStaffProfileRoutes(service?: ReturnType<typeof createStaffProfileService>) {
  const current = () => service ?? configuration().service;
  const contracts = staffContracts;
  return [
    route({ ...contracts.listProfiles, request: { query: contracts.listProfiles.query }, responses: { 200: { description: 'Staff profiles', content: { 'application/json': { schema: contracts.listProfiles.response } } } } }, async (c) => {
      c.header('Cache-Control', 'no-store'); return c.json(await current().listProfiles(actor(c).gymId, c.req.valid('query')), 200);
    }),
    route({ ...contracts.getProfile, request: { params: contracts.getProfile.params }, responses: { 200: { description: 'Staff profile', content: { 'application/json': { schema: contracts.getProfile.response } } } } }, async (c) => {
      c.header('Cache-Control', 'no-store'); return c.json(await current().getProfile(actor(c).gymId, c.req.valid('param').staffProfileId), 200);
    }),
    route({ ...contracts.createProfile, request: { body: { required: true, content: { 'application/json': { schema: contracts.createProfile.body } } } }, responses: { 200: { description: 'Staff profile created', content: { 'application/json': { schema: contracts.createProfile.response } } } } }, async (c) => c.json(await current().createProfile(actor(c), c.req.valid('json')), 200)),
    route({ ...contracts.updateProfile, request: { params: contracts.updateProfile.params, body: { required: true, content: { 'application/json': { schema: contracts.updateProfile.body } } } }, responses: { 200: { description: 'Staff profile updated', content: { 'application/json': { schema: contracts.updateProfile.response } } } } }, async (c) => c.json(await (service ? service.updateProfile(actor(c), c.req.valid('param').staffProfileId, c.req.valid('json')) : configuration().photos.update(actor(c), c.req.valid('param').staffProfileId, c.req.valid('json'))), 200)),
    route({ ...contracts.listRoles, request: { query: contracts.listRoles.query }, responses: { 200: { description: 'Staff roles', content: { 'application/json': { schema: contracts.listRoles.response } } } } }, async (c) => {
      c.header('Cache-Control', 'no-store'); return c.json(await current().listRoles(actor(c).gymId, c.req.valid('query')), 200);
    }),
    route({ ...contracts.grantRole, request: { body: { required: true, content: { 'application/json': { schema: contracts.grantRole.body } } } }, responses: { 200: { description: 'Staff role granted', content: { 'application/json': { schema: contracts.grantRole.response } } } } }, async (c) => c.json(await current().grantRole(actor(c), c.req.valid('json')), 200)),
    route({ ...contracts.updateRole, request: { params: contracts.updateRole.params, body: { required: true, content: { 'application/json': { schema: contracts.updateRole.body } } } }, responses: { 200: { description: 'Staff role updated', content: { 'application/json': { schema: contracts.updateRole.response } } } } }, async (c) => c.json({ data: (await current().changeRole(actor(c), c.req.valid('param').staffRoleId, c.req.valid('json')))! }, 200)),
    route({ ...contracts.revokeRole, request: { params: contracts.revokeRole.params, body: { required: true, content: { 'application/json': { schema: contracts.revokeRole.body } } } }, responses: { 200: { description: 'Staff role revoked', content: { 'application/json': { schema: contracts.revokeRole.response } } } } }, async (c) => {
      await current().changeRole(actor(c), c.req.valid('param').staffRoleId, c.req.valid('json'), true); return c.json({ data: null }, 200);
    }),
  ];
}
/** Integration injects the invitation service with createSmtpResolver and the canonical gym origin. */
export function createStaffInvitationRoutes(service: StaffInvitationService | (() => StaffInvitationService), origin: Origin) {
  const current = () => typeof service === 'function' ? service() : service;
  const invite = staffContracts.inviteStaff, t = createTranslator(locales.en ?? {});
  return [route({ ...invite, request: { body: { required: true, content: { 'application/json': { schema: invite.body } } } }, responses: { 200: { description: 'Staff invitation', content: { 'application/json': { schema: invite.response } } } } }, async (c) => {
    c.header('Cache-Control', 'no-store'); return c.json(await current().inviteStaff(actor(c), c.req.valid('json'), origin(c)), 200);
  }),
  // TODO(CCR T11): promote these public acceptance routes into shared contracts.
  route({ method: 'post', path: '/api/staff/invitations/accept', permission: { kind: 'public' }, middleware: rateLimit({ limit: 10 }),
    request: { body: { required: true, content: { 'application/json': { schema: acceptStaffInvitationSchema } } } },
    responses: { 200: { description: 'Invitation accepted', content: { 'application/json': { schema: z.strictObject({ data: z.null() }) } } } },
  }, async (c) => {
    c.header('Cache-Control', 'no-store'); const { gym, clock } = c.get('context');
    return c.json(await current().acceptInvitation(gym.gymId, c.req.valid('json'), clock), 200);
  }),
  route({ method: 'get', path: '/staff-invitation', permission: { kind: 'public' }, responses: { 200: { description: 'Accept staff invitation', content: { 'text/html': { schema: z.string() } } } } }, async (c) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    return c.html(invitationPage(t, await current().passwordRequired(c.get('context').gym.gymId)).toString(), 200);
  })];
}
export const routes = [
  ...createStaffProfileRoutes(),
  ...createStaffInvitationRoutes(() => configuration().invitations, (c) => configuration().origin(c)),
  ...createStaffPhotoRoutes(() => configuration().photos),
];
