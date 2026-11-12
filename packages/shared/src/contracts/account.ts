// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { instantSchema } from './common.js';
import { staffRoleNameSchema } from './staff.js';
import type { EndpointContract } from './definition.js';

/**
 * The signed-in login's own account in the current gym. Every route acts only for the request's session; no request names
 * another login. The routes are public in the registry and refuse a request without a staff or portal session themselves.
 */
export const accountEmailSchema = z.email().max(254);
/** A sign-in email change link's token: 32 random bytes, hex. Only its hash is stored. */
export const emailChangeTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Whether this login may change its sign-in email here: `available`; `several_gyms` when the install runs several gyms, where
 * one login's address is shared by every gym it belongs to; `no_email` when this gym can't send the confirmation link.
 */
export const emailChangeAvailabilitySchema = z.enum(['available', 'several_gyms', 'no_email']);
export const accountSummarySchema = z.strictObject({
  email: z.string().min(1),
  /** Whether the login has a password (whether password sign-in is on for the gym is in the shell bootstrap). */
  password: z.boolean(),
  /** Whether a Google account is linked to the login. */
  googleLinked: z.boolean(),
  /** Staff roles in this gym. */
  roles: z.array(staffRoleNameSchema).readonly(),
  /** The households this login is linked to in this gym, as payer or member. */
  households: z.array(z.strictObject({ name: z.string(), scope: z.enum(['payer', 'member']) })).readonly(),
  /** A change waiting for its link to be opened, if any. */
  pendingEmail: z.strictObject({ email: z.string().min(1), expiresAt: instantSchema }).nullable(),
  emailChange: emailChangeAvailabilitySchema,
});
export const requestEmailChangeSchema = z.strictObject({ newEmail: accountEmailSchema });
export const confirmEmailChangeSchema = z.strictObject({ token: emailChangeTokenSchema });
const signedIn = { kind: 'public' } as const;
export const accountContracts = {
  get: { method: 'get', path: '/api/account', permission: signedIn,
    description: 'The signed-in login\'s own account. Answers 401 without a staff or portal session.',
    response: z.strictObject({ data: accountSummarySchema }) },
  requestEmailChange: { method: 'post', path: '/api/account/email', permission: signedIn,
    description: 'Sends a link to the new address; the change applies only when that link is opened. Answers 401 without a staff or portal session, 409 when another login uses the address.',
    body: requestEmailChangeSchema,
    response: z.strictObject({ data: z.strictObject({ email: z.string().min(1), expiresAt: instantSchema }) }) },
  confirmEmailChange: { method: 'post', path: '/api/account/email/confirm', permission: { kind: 'public' },
    description: 'Applies a sign-in email change from the link sent to the new address. The token is the authority; a session of another login is refused.',
    body: confirmEmailChangeSchema,
    response: z.strictObject({ data: z.strictObject({ email: z.string().min(1) }) }) },
} as const satisfies Record<string, EndpointContract>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type EmailChangeAvailability = z.infer<typeof emailChangeAvailabilitySchema>;
