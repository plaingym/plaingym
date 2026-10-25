// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
export const demoRoleSchema = z.enum(['owner', 'coach', 'student']);
export type DemoRole = z.infer<typeof demoRoleSchema>;
export const sandboxResponse = z.strictObject({ data: z.strictObject({ gymId: z.uuid(), origin: z.url(), expiresAt: z.iso.datetime(), kioskToken: z.string() }) });
export const demoStatusResponse = z.strictObject({ data: z.strictObject({ expiresAt: z.iso.datetime() }) });
export const outboxMessage = z.strictObject({ id: z.uuid(), recipient: z.string(), subject: z.string(), html: z.string(), text: z.string(), sentAt: z.iso.datetime() });
export const outboxResponse = z.strictObject({ data: z.array(outboxMessage), next: z.uuid().nullable() });
export const outboxQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const outboxParams = z.object({ id: z.uuid() });
export const demoLoginRequest = z.strictObject({ role: demoRoleSchema });
export const demoLoginResponse = z.strictObject({ data: z.strictObject({ redirect: z.enum(['/admin', '/portal']) }) });
export const outboxMessageResponse = z.strictObject({ data: outboxMessage });
export const demoEntryResponse = z.strictObject({ data: z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('entry') }),
  z.strictObject({ mode: z.literal('sandbox'), expiresAt: z.iso.datetime() }),
]) });
export const demoContracts = {
  entry: { method: 'get', path: '/api/demo', permission: { kind: 'public' }, response: demoEntryResponse },
  create: { method: 'post', path: '/api/demo/sandboxes', permission: { kind: 'public' }, successStatus: 201, response: sandboxResponse },
  status: { method: 'get', path: '/api/demo/status', permission: { kind: 'public' }, response: demoStatusResponse },
  login: { method: 'post', path: '/api/demo/login', permission: { kind: 'public' }, body: demoLoginRequest, response: demoLoginResponse },
  outbox: { method: 'get', path: '/api/demo/outbox', permission: { kind: 'staff', capability: 'settings.manage' }, query: outboxQuery, response: outboxResponse },
  message: { method: 'get', path: '/api/demo/outbox/{id}', permission: { kind: 'staff', capability: 'settings.manage' }, params: outboxParams, response: outboxMessageResponse },
} as const satisfies Record<string, EndpointContract>;
