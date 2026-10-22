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
  it('denies billing widgets to coaches while allowing them to read mat widgets', () => {
    for (const role of staffRoles) {
      expect(canStaff([role], dashboardContracts.mat.permission.capability)).toBe(true);
      expect(canStaff([role], dashboardContracts.billing.permission.capability)).toBe(role !== 'coach');
    }
  });
});
