// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { currencySchema, idSchema } from './common.js';
import { storedTimezoneSchema } from './settings.js';
import { staffRoleNameSchema } from './staff.js';
import type { EndpointContract } from './definition.js';

/** Host-resolved public gym details and only the current login's access. */
export const shellSessionSchema = z.strictObject({
  userId: idSchema,
  /**
   * The name this gym knows the login by (staff profile, else the linked member), else the login's own name, or its
   * address in `multi` mode (another gym may have set the name). Null without a request session; clients show a generic label.
   */
  displayName: z.string().min(1).nullable(),
  roles: z.array(staffRoleNameSchema).readonly(),
  member: z.boolean(),
});
export const shellBootstrapSchema = z.strictObject({
  gym: z.strictObject({ id: idSchema, name: z.string().min(1), timezone: storedTimezoneSchema, currency: currencySchema, enabledModules: z.array(z.string().min(1)).readonly() }),
  session: shellSessionSchema.nullable(),
  // `google` is present when Google sign-in is available on this install; absent means it isn't.
  login: z.strictObject({ password: z.boolean(), magicLink: z.boolean(), google: z.boolean().optional() }),
});
export const shellBootstrapResponseSchema = z.strictObject({ data: shellBootstrapSchema });
export const shellContracts = {
  bootstrap: { method: 'get', path: '/api/auth/bootstrap', permission: { kind: 'public' }, response: shellBootstrapResponseSchema },
} as const satisfies Record<string, EndpointContract>;
export type ShellBootstrap = z.infer<typeof shellBootstrapSchema>;
export type ShellSession = z.infer<typeof shellSessionSchema>;
