// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
export const demoRoleSchema = z.enum(['owner', 'coach', 'student']);
export type DemoRole = z.infer<typeof demoRoleSchema>;
/** Stripe's documented test card; sandboxes only ever use the shared test-mode account. */
export const demoTestCard = '4242 4242 4242 4242';
export const sandboxResponse = z.strictObject({ data: z.strictObject({ gymId: z.uuid(), origin: z.url(), expiresAt: z.iso.datetime(), kioskToken: z.string() }) });
export const demoStatusResponse = z.strictObject({ data: z.strictObject({ expiresAt: z.iso.datetime() }) });
export const outboxMessage = z.strictObject({ id: z.uuid(), recipient: z.string(), subject: z.string(), text: z.string(), sentAt: z.iso.datetime() });
export const outboxResponse = z.strictObject({ data: z.array(outboxMessage), next: z.uuid().nullable() });
export const outboxQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const outboxParams = z.object({ id: z.uuid() });
/** A one-click login: a seeded role, or a member who joined in this sandbox (by the `id` the demo menu lists). */
export const demoLoginRequest = z.union([z.strictObject({ role: demoRoleSchema }), z.strictObject({ member: z.uuid() })]);
export type DemoLoginTarget = z.infer<typeof demoLoginRequest>;
export const demoLoginResponse = z.strictObject({ data: z.strictObject({ redirect: z.enum(['/admin', '/portal']) }) });
/** How many joined members the demo menu offers, latest first. */
export const demoJoinedMemberLimit = 5;
export const demoJoinedMember = z.strictObject({ id: z.uuid(), name: z.string() });
/** What the demo menu needs beyond discovery: the members who joined here, and whether the gym's website is on. */
export const demoMenuResponse = z.strictObject({ data: z.strictObject({
  members: z.array(demoJoinedMember).max(demoJoinedMemberLimit), website: z.boolean(),
}) });
/** The path that signs in with the latest sign-in link sent to an address, from the sandbox's outbox. */
export const demoSignInLinkPath = '/api/auth/magic-link/verify';
export const demoSignInLinkRequest = z.strictObject({ email: z.string().trim().min(1).max(254) });
export const demoSignInLinkResponse = z.strictObject({ data: z.strictObject({
  href: z.string().max(4096).refine((href) => href.startsWith(demoSignInLinkPath + '?'), 'Not a sign-in link'),
}) });
export const outboxMessageResponse = z.strictObject({ data: outboxMessage });
export const demoEntryResponse = z.strictObject({ data: z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('entry') }),
  z.strictObject({ mode: z.literal('sandbox'), expiresAt: z.iso.datetime(), join: z.boolean() }),
]) });
export const demoContracts = {
  entry: { method: 'get', path: '/api/demo', permission: { kind: 'public' }, response: demoEntryResponse },
  create: { method: 'post', path: '/api/demo/sandboxes', permission: { kind: 'public' }, successStatus: 201, response: sandboxResponse },
  status: { method: 'get', path: '/api/demo/status', permission: { kind: 'public' }, response: demoStatusResponse },
  login: { method: 'post', path: '/api/demo/login', permission: { kind: 'public' }, body: demoLoginRequest, response: demoLoginResponse },
  menu: { method: 'get', path: '/api/demo/menu', permission: { kind: 'public' }, response: demoMenuResponse },
  signInLink: { method: 'post', path: '/api/demo/sign-in-link', permission: { kind: 'public' }, body: demoSignInLinkRequest, response: demoSignInLinkResponse },
  outbox: { method: 'get', path: '/api/demo/outbox', permission: { kind: 'staff', capability: 'settings.manage' }, query: outboxQuery, response: outboxResponse },
  message: { method: 'get', path: '/api/demo/outbox/{id}', permission: { kind: 'staff', capability: 'settings.manage' }, params: outboxParams, response: outboxMessageResponse },
  preview: { method: 'get', path: '/api/demo/outbox/{id}/preview', permission: { kind: 'staff', capability: 'settings.manage' }, params: outboxParams, response: z.string() },
} as const satisfies Record<string, EndpointContract>;
