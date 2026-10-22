// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idSchema } from './common.js';
import { staffRoleNameSchema } from './staff.js';
import type { EndpointContract } from './definition.js';

/** Host-resolved public gym details and only the current login's access. */
export const shellSessionSchema = z.strictObject({
  userId: idSchema,
  roles: z.array(staffRoleNameSchema).readonly(),
  member: z.boolean(),
});
export const shellBootstrapSchema = z.strictObject({
  gym: z.strictObject({ id: idSchema, name: z.string().min(1), enabledModules: z.array(z.string().min(1)).readonly() }),
  session: shellSessionSchema.nullable(),
  login: z.strictObject({ password: z.boolean(), magicLink: z.boolean() }),
});
export const shellBootstrapResponseSchema = z.strictObject({ data: shellBootstrapSchema });
export const shellContracts = {
  bootstrap: { method: 'get', path: '/api/auth/bootstrap', permission: { kind: 'public' }, response: shellBootstrapResponseSchema },
} as const satisfies Record<string, EndpointContract>;
export type ShellBootstrap = z.infer<typeof shellBootstrapSchema>;
export type ShellSession = z.infer<typeof shellSessionSchema>;
