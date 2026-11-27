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
/** Which link a pending change waits for: the one sent to the current address first, or the one sent to the new address. */
const emailChangeAwaitingSchema = z.enum(['current_address', 'new_address']);
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
  /** A change waiting for a link to be opened, if any: the current address's link first, then the new address's. */
  pendingEmail: z.strictObject({ email: z.string().min(1), expiresAt: instantSchema, awaiting: emailChangeAwaitingSchema }).nullable(),
  emailChange: emailChangeAvailabilitySchema,
  /**
   * How a change request proves the login: `password`, its current password (the login has one and password sign-in is on
   * for the gym); `current_address`, a link sent to the current sign-in email, opened before the new address gets its link.
   */
  emailChangeProof: z.enum(['password', 'current_address']),
});
/** `currentPassword` is required where the account's `emailChangeProof` is `password`, and ignored otherwise. */
export const requestEmailChangeSchema = z.strictObject({ newEmail: accountEmailSchema, currentPassword: z.string().min(1).max(128).optional() });
export const confirmEmailChangeSchema = z.strictObject({ token: emailChangeTokenSchema });
export const changePasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) });
const signedIn = { kind: 'public' } as const;
export const accountContracts = {
  get: { method: 'get', path: '/api/account', permission: signedIn,
    description: 'The signed-in login\'s own account. Answers 401 without a staff or portal session.',
    response: z.strictObject({ data: accountSummarySchema }) },
  requestEmailChange: { method: 'post', path: '/api/account/email', permission: signedIn,
    description: 'Starts a sign-in email change once the login is proved. With the `password` proof the body carries the current password (400 `currentPassword: required` or `wrong_password`, 429 after too many wrong ones, counted with password sign-in); the new address then gets a link, or an in-use notice when another login uses it, with the same response, and the old address gets a notice with the new address masked (`awaiting: new_address`). With the `current_address` proof a link goes to the current address first and nothing to the new one yet (`awaiting: current_address`). The change applies only when the new address\'s link is opened; an address in use is refused then. Answers 401 without a staff or portal session.',
    body: requestEmailChangeSchema,
    response: z.strictObject({ data: z.strictObject({ email: z.string().min(1), expiresAt: instantSchema, awaiting: emailChangeAwaitingSchema }) }) },
  confirmEmailChange: { method: 'post', path: '/api/account/email/confirm', permission: { kind: 'public' },
    description: 'Opens a sign-in email change link. The current address\'s link sends the new address its link (or the in-use notice) and changes nothing yet (`status: sent`); the new address\'s link applies the change (`status: changed`). `email` is the new address. The token is the authority and is used once; a session of another login is refused.',
    body: confirmEmailChangeSchema,
    response: z.strictObject({ data: z.strictObject({ email: z.string().min(1), status: z.enum(['changed', 'sent']) }) }) },
  changePassword: { method: 'post', path: '/api/account/password', permission: signedIn,
    description: 'Changes the signed-in login\'s own password after checking the current one. Ends the login\'s other sessions in this gym. Answers 401 without a staff or portal session, 403 where password sign-in is off.',
    body: changePasswordSchema,
    response: z.strictObject({ data: z.null() }) },
} as const satisfies Record<string, EndpointContract>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type EmailChangeAvailability = z.infer<typeof emailChangeAvailabilitySchema>;
