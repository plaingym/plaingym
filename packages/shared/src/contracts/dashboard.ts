// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema, instantSchema, dateSchema, moneySchema, currencySchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

const count = z.int().nonnegative();
const metricMoney = moneySchema.extend({ amountCents: moneySchema.shape.amountCents.nonnegative() });
const common = { titleKey: z.string().min(1), status: z.enum(['ready', 'not_configured', 'unavailable']) };
export const dashboardMemberSchema = z.strictObject({
  memberId: idSchema, firstName: z.string(), lastName: z.string(), lastSeenAt: instantSchema.nullable(),
});
export const matDashboardWidgetSchema = z.discriminatedUnion('id', [
  z.strictObject({ ...common, id: z.literal('active_members'), count }),
  z.strictObject({ ...common, id: z.literal('not_seen'), days: z.literal(14), count,
    members: z.array(dashboardMemberSchema).max(100) }),
  z.strictObject({ ...common, id: z.literal('promotion_ready'), count,
    members: z.array(dashboardMemberSchema.extend({ programId: idSchema, rankId: idSchema })).max(100) }),
]);
export const billingDashboardWidgetSchema = z.discriminatedUnion('id', [
  z.strictObject({ ...common, id: z.literal('mrr'), money: metricMoney }),
  z.strictObject({ ...common, id: z.literal('past_due'), money: metricMoney, invoiceCount: count }),
  z.strictObject({ ...common, id: z.literal('upcoming_charges'), money: metricMoney, invoiceCount: count,
    from: dateSchema, through: dateSchema }).refine((value) => value.from <= value.through, 'Invalid date range'),
  z.strictObject({ ...common, id: z.literal('disputes'), money: metricMoney, count }),
]);
/** A registry extension has a namespaced ID and a rendering kind the UI already knows. */
export const extensionDashboardWidgetSchema = z.strictObject({
  ...common, id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/),
  kind: z.literal('count'), count,
  // An optional shortlist under the count. A widget that lists items and has none left is not shown. Links stay under
  // `/admin`: no `.` or `..` segments and no percent-encoding in the path, which browsers would resolve outside it.
  items: z.array(z.strictObject({ label: z.string().min(1).max(200),
    href: z.string().regex(/^\/admin(?:\/(?!\.\.?(?:[/#]|$))[A-Za-z0-9\-._~]*)*(?:#[A-Za-z0-9\-._~%]+)?$/) })).max(20).optional(),
});
export const dashboardWidgetSchema = z.union([
  matDashboardWidgetSchema, billingDashboardWidgetSchema, extensionDashboardWidgetSchema,
]);
export const matDashboardResponseSchema = z.strictObject({ data: z.strictObject({
  generatedAt: instantSchema, widgets: z.array(z.union([matDashboardWidgetSchema, extensionDashboardWidgetSchema]))
    .refine((widgets) => new Set(widgets.map((widget) => widget.id)).size === widgets.length, 'Duplicate widget'),
}) });
export const billingDashboardResponseSchema = z.strictObject({ data: z.strictObject({
  generatedAt: instantSchema, currency: currencySchema,
  widgets: z.array(billingDashboardWidgetSchema)
    .refine((widgets) => new Set(widgets.map((widget) => widget.id)).size === widgets.length, 'Duplicate widget'),
}).refine((value) => value.widgets.every((widget) => widget.money.currency === value.currency),
  'All widgets must use the gym currency') });
export const dashboardContracts = {
  mat: { method: 'get', path: '/api/dashboard',
    permission: { kind: 'staff', capability: 'members.read' } satisfies RoutePermission,
    response: matDashboardResponseSchema },
  billing: { method: 'get', path: '/api/dashboard/billing',
    permission: { kind: 'staff', capability: 'billing.read' } satisfies RoutePermission,
    response: billingDashboardResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;
export type MatDashboardWidget = z.infer<typeof matDashboardWidgetSchema>;
export type BillingDashboardWidget = z.infer<typeof billingDashboardWidgetSchema>;
export type MatDashboardResponse = z.infer<typeof matDashboardResponseSchema>;
export type BillingDashboardResponse = z.infer<typeof billingDashboardResponseSchema>;
