// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
// TODO(CCR): move the demo and gym-delete contracts to @plaingym/shared/contracts.
export const demoRoleSchema = z.enum(['owner', 'coach', 'student']);
export type DemoRole = z.infer<typeof demoRoleSchema>;
export const sandboxResponse = z.strictObject({ data: z.strictObject({ gymId: z.uuid(), origin: z.url(), expiresAt: z.iso.datetime(), kioskToken: z.string() }) });
export const demoStatusResponse = z.strictObject({ data: z.strictObject({ expiresAt: z.iso.datetime() }) });
export const outboxMessage = z.strictObject({ id: z.uuid(), recipient: z.string(), subject: z.string(), html: z.string(), text: z.string(), sentAt: z.iso.datetime() });
export const outboxResponse = z.strictObject({ data: z.array(outboxMessage), next: z.uuid().nullable() });
export const outboxQuery = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const outboxParams = z.object({ id: z.uuid() });
export const deleteRequest = z.strictObject({ revision: z.number().int().positive(), confirmation: z.literal('DELETE') });
export const deleteResponse = z.strictObject({ data: z.strictObject({ deleted: z.literal(true) }) });
