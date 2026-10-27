// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema, currencySchema, instantSchema, revisionSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

const manage = { kind: 'staff', capability: 'settings.manage' } as const satisfies RoutePermission;
const goLive = { kind: 'staff', capability: 'go_live.manage' } as const satisfies RoutePermission;
const name = z.string().trim().min(1);
export const gymTimezoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Use a supported IANA timezone');
export const gymAddressSchema = z.strictObject({
  line1: z.string().optional(), line2: z.string().optional(), city: z.string().optional(),
  region: z.string().optional(), postalCode: z.string().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export const gymBrandingSchema = z.strictObject({
  logoKey: z.string().min(1).nullable().optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
/** Open mat counts toward classes attended (rank criteria and class totals) only when enabled. */
export const bookingRulesSchema = z.strictObject({
  bookingWindowDays: z.int32().nonnegative(), cancellationCutoffMinutes: z.int32().nonnegative(),
  openMatCountsAsClass: z.boolean(),
});
/** Retry days are counted from the first failure; an empty list disables automatic retries. */
export const billingRulesSchema = z.strictObject({
  retryDays: z.array(z.int32().min(1).max(28)).max(4).refine(
    (days) => days.every((day, index) => index === 0 || day > days[index - 1]!),
    'Use strictly increasing retry days',
  ).describe('Up to four strictly increasing whole days from 1 to 28 after the first failure. Empty means no automatic retries.'),
});
export const goLiveSwitchesSchema = z.strictObject({ billingEnabled: z.boolean(), memberEmailsEnabled: z.boolean() });
/** An allowlist projection: credentials, PIN/QR keys, and opaque settings never leave the service. */
export const gymSettingsSchema = z.strictObject({
  id: idSchema, name, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), timezone: gymTimezoneSchema,
  address: gymAddressSchema, branding: gymBrandingSchema,
  websiteEnabled: z.boolean(), existingSiteUrl: z.url({ protocol: /^https?$/ }).nullable(),
  currency: currencySchema, ...bookingRulesSchema.shape, ...billingRulesSchema.shape, ...goLiveSwitchesSchema.shape,
  revision: revisionSchema, createdAt: instantSchema, updatedAt: instantSchema,
});
export const updateGymSettingsRequestSchema = gymSettingsSchema.pick({
  name: true, timezone: true, address: true, branding: true, websiteEnabled: true, existingSiteUrl: true,
}).partial().extend({ revision: revisionSchema })
  .refine((value) => Object.keys(value).length > 1, 'Supply at least one change');
export const updateBookingRulesRequestSchema = bookingRulesSchema.partial().extend({ revision: revisionSchema })
  .refine((value) => Object.keys(value).length > 1, 'Supply at least one change');
export const updateBillingRulesRequestSchema = billingRulesSchema.extend({ revision: revisionSchema });
/** The service returns conflict if any billing record already references the currency. */
export const updateGymCurrencyRequestSchema = z.strictObject({ revision: revisionSchema, currency: currencySchema });
export const updateGoLiveRequestSchema = goLiveSwitchesSchema.partial().extend({ revision: revisionSchema })
  .refine((value) => Object.keys(value).length > 1, 'Supply at least one change');
export const goLiveChecklistItemSchema = z.strictObject({
  id: z.enum(['gym_details', 'members_imported', 'schedule_ready', 'stripe_ready', 'cards_collected', 'waivers_signed', 'smtp_ready', 'backup_ready', 'webhook_ready', 'reconciliation_complete']),
  status: z.enum(['ready', 'needs_attention', 'not_applicable']), message: z.string(),
});
export const goLiveChecklistResponseSchema = z.strictObject({ data: z.strictObject({
  revision: revisionSchema, ...goLiveSwitchesSchema.shape, items: z.array(goLiveChecklistItemSchema),
}) });
export const gymSettingsResponseSchema = z.strictObject({ data: gymSettingsSchema });
export const deleteGymRequestSchema = z.strictObject({ revision: revisionSchema, confirmation: z.literal('DELETE') });
export const deleteGymResponseSchema = z.strictObject({ data: z.strictObject({ deleted: z.literal(true) }) });
export const settingsContracts = {
  deleteGym: { method: 'delete', path: '/api/settings/gym', permission: { kind: 'staff', capability: 'ownership.transfer' },
    body: deleteGymRequestSchema, response: deleteGymResponseSchema },
  get: { method: 'get', path: '/api/settings', permission: manage, response: gymSettingsResponseSchema },
  updateGeneral: { method: 'patch', path: '/api/settings', permission: manage,
    body: updateGymSettingsRequestSchema, response: gymSettingsResponseSchema },
  updateBookingRules: { method: 'patch', path: '/api/settings/booking', permission: manage,
    body: updateBookingRulesRequestSchema, response: gymSettingsResponseSchema },
  updateBillingRules: { method: 'patch', path: '/api/settings/billing', permission: manage,
    body: updateBillingRulesRequestSchema, response: gymSettingsResponseSchema },
  updateCurrency: { method: 'patch', path: '/api/settings/currency', permission: manage,
    body: updateGymCurrencyRequestSchema, response: gymSettingsResponseSchema },
  updateGoLive: { method: 'patch', path: '/api/settings/go-live', permission: goLive,
    body: updateGoLiveRequestSchema, response: goLiveChecklistResponseSchema },
  goLiveChecklist: { method: 'get', path: '/api/settings/go-live', permission: goLive,
    response: goLiveChecklistResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type GymSettings = z.infer<typeof gymSettingsSchema>;
export type GymAddress = z.infer<typeof gymAddressSchema>;
export type GymBranding = z.infer<typeof gymBrandingSchema>;
export type BookingRules = z.infer<typeof bookingRulesSchema>;
export type BillingRules = z.infer<typeof billingRulesSchema>;
export type GoLiveSwitches = z.infer<typeof goLiveSwitchesSchema>;
export type UpdateGymSettingsRequest = z.infer<typeof updateGymSettingsRequestSchema>;
export type UpdateBookingRulesRequest = z.infer<typeof updateBookingRulesRequestSchema>;
export type UpdateBillingRulesRequest = z.infer<typeof updateBillingRulesRequestSchema>;
export type UpdateGymCurrencyRequest = z.infer<typeof updateGymCurrencyRequestSchema>;
export type UpdateGoLiveRequest = z.infer<typeof updateGoLiveRequestSchema>;
export type GoLiveChecklistItem = z.infer<typeof goLiveChecklistItemSchema>;
