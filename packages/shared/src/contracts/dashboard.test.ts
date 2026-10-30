// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  matDashboardResponseSchema, billingDashboardResponseSchema, dashboardContracts,
  extensionDashboardWidgetSchema,
} from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const generatedAt = '2026-10-21T20:00:00Z';
const matWidget = { id: 'active_members', titleKey: 'dashboard.active_members', status: 'ready', count: 20 };
const moneyWidget = { id: 'mrr', titleKey: 'dashboard.mrr', status: 'ready', money: { amountCents: 10000, currency: 'CAD' } };

describe('dashboard contracts', () => {
  it('keeps billing widgets off the general staff dashboard', () => {
    expect(matDashboardResponseSchema.parse({ data: { generatedAt, widgets: [matWidget] } }).data.widgets).toHaveLength(1);
    expect(matDashboardResponseSchema.safeParse({ data: { generatedAt, widgets: [moneyWidget] } }).success).toBe(false);
    expect(matDashboardResponseSchema.safeParse({ data: { generatedAt, widgets: [{ ...matWidget, money: moneyWidget.money }] } }).success).toBe(false);
  });
  it('requires integer cents and one explicit gym currency across billing widgets', () => {
    const response = { data: { generatedAt, currency: 'CAD', widgets: [moneyWidget] } };
    expect(billingDashboardResponseSchema.parse(response)).toEqual(response);
    expect(billingDashboardResponseSchema.safeParse({ data: { ...response.data, currency: 'USD' } }).success).toBe(false);
    expect(billingDashboardResponseSchema.safeParse({ data: { ...response.data, widgets: [{ ...moneyWidget,
      money: { amountCents: 10.1, currency: 'CAD' } }] } }).success).toBe(false);
  });
  it('rejects backwards upcoming-charge ranges and duplicate widget identities', () => {
    const upcoming = { id: 'upcoming_charges', titleKey: 'dashboard.upcoming', status: 'ready',
      money: { amountCents: 100, currency: 'CAD' }, invoiceCount: 1, from: '2026-11-01', through: '2026-10-21' };
    expect(billingDashboardResponseSchema.safeParse({ data: { generatedAt, currency: 'CAD', widgets: [upcoming] } }).success).toBe(false);
    expect(matDashboardResponseSchema.safeParse({ data: { generatedAt, widgets: [matWidget, matWidget] } }).success).toBe(false);
  });
  it('supports registered count widgets without allowing an extension to impersonate a built-in', () => {
    const extension = { id: 'example.custom-count', kind: 'count', titleKey: 'example.count', status: 'ready', count: 10 };
    expect(extensionDashboardWidgetSchema.parse(extension)).toEqual(extension);
    expect(extensionDashboardWidgetSchema.safeParse({ ...extension, id: 'mrr' }).success).toBe(false);
    expect(matDashboardResponseSchema.parse({ data: { generatedAt, widgets: [extension] } }).data.widgets[0]?.id).toBe(extension.id);
  });
  it('lets an extension widget list at most twenty admin links, and nothing else', () => {
    const extension = { id: 'example.custom-count', kind: 'count', titleKey: 'example.count', status: 'ready', count: 30 };
    const link = { label: 'Adams household', href: '/admin/members/019ab4f0-0000-7000-8000-000000000002#memberTabs.portal-access' };
    expect(extensionDashboardWidgetSchema.parse({ ...extension, items: [link] })).toEqual({ ...extension, items: [link] });
    expect(extensionDashboardWidgetSchema.safeParse({ ...extension, items: Array.from({ length: 21 }, () => link) }).success).toBe(false);
    for (const href of ['https://example.test/admin/x', '//example.test/admin/x', '/portal/x', '/admin/x y', 'javascript:alert(1)', '/admin/x#a b',
      '/admin/../portal/x', '/admin/x/../../api/x', '/admin/..', '/admin/./x', '/admin/%2e%2e/portal/x', '/administrator', '/admin..'])
      expect(extensionDashboardWidgetSchema.safeParse({ ...extension, items: [{ label: 'Link', href }] }).success, href).toBe(false);
    expect(extensionDashboardWidgetSchema.safeParse({ ...extension, items: [{ label: '', href: '/admin/x' }] }).success).toBe(false);
    expect(extensionDashboardWidgetSchema.safeParse({ ...extension, items: [{ label: 'Link', href: '/admin/x', extra: 1 }] }).success).toBe(false);
  });
  it('denies billing widgets to coaches while allowing them to read mat widgets', () => {
    for (const role of staffRoles) {
      expect(canStaff([role], dashboardContracts.mat.permission.capability)).toBe(true);
      expect(canStaff([role], dashboardContracts.billing.permission.capability)).toBe(role !== 'coach');
    }
  });
});
