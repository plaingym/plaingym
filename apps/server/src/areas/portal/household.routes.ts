// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalHouseholdService, ok, type PortalHouseholdService } from './household.js';

export function createPortalHouseholdProfileRoutes(service: PortalHouseholdService = createPortalHouseholdService()) {
  const { profile, members, updateMember, household, updateHousehold, memberships } = contracts;
  return [
    route({ ...profile, request: { params: profile.params }, responses: ok('Household member profile', profile.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.profile(portalIdentity(c.get('context')), c.req.valid('param').memberId) }, 200);
    }),
    route({ ...members, request: { query: members.query }, responses: ok('Household members', members.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await service.list(portalIdentity(c.get('context')), c.req.valid('query')), 200);
    }),
    route({ ...updateMember, request: { params: updateMember.params, body: { required: true, content: { 'application/json': { schema: updateMember.body } } } }, responses: ok('Updated household member', updateMember.response) }, async c => {
      const context = c.get('context');
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.updateMember(portalIdentity(context), c.req.valid('param').memberId, c.req.valid('json'), context.gym.timezone) }, 200);
    }),
    route({ ...household, responses: ok('Household contact details', household.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.household(portalIdentity(c.get('context'))) }, 200);
    }),
    route({ ...updateHousehold, request: { body: { required: true, content: { 'application/json': { schema: updateHousehold.body } } } }, responses: ok('Updated household contact details', updateHousehold.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await service.updateHousehold(portalIdentity(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...memberships, request: { params: memberships.params, query: memberships.query }, responses: ok('Member memberships (read-only)', memberships.response) }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await service.memberships(portalIdentity(c.get('context')), c.req.valid('param').memberId, c.req.valid('query')), 200);
    }),
  ];
}
export const routes = createPortalHouseholdProfileRoutes();
