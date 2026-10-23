// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// Shared stored value sets, used by staff and member projections alike.
export const memberStatusSchema = z.enum(['prospect', 'trial', 'active', 'frozen', 'cancelled', 'visitor']);
export const classSessionStatusSchema = z.enum(['scheduled', 'cancelled']);
export const attendanceSourceSchema = z.enum(['kiosk', 'coach', 'import']);
/** Open mat is a visit, not a class; gyms choose whether it counts toward classes attended. */
export const classKindSchema = z.enum(['class', 'open_mat']);
export const billingIntervalSchema = z.enum(['monthly', 'annual']);
export const membershipStatusSchema = z.enum(['pending', 'trial', 'active', 'frozen', 'cancelled']);
export const invoiceKindSchema = z.enum(['cycle', 'one_off']);
export const invoiceStatusSchema = z.enum(['draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded']);
export const paymentAttemptStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'requires_action']);
