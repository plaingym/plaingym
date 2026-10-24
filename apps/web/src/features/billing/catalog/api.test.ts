// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createBillingClient } from './api.js';
import { decimalUnits } from './format.js';

const id = '019a0af0-9c00-7000-8000-000000000001';
const plan = { id, createdAt: '2026-10-23T12:00:00Z', name: 'Plan', currency: 'CAD', amountCents: 9999,
  interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
describe('billing contract transport', () => {
  it('validates writes, carries revisions and restricts transport to the same origin', async () => {
    const requests: { path: string; options: RequestInit | undefined }[] = [];
    const client = createBillingClient(async (path, options) => {
      requests.push({ path: String(path), options }); return Response.json({ data: plan });
    });
    await client.call('updatePlan', { revision: 1, name: 'Changed' }, { planId: id });
    expect(requests[0]).toMatchObject({ path: '/api/billing/plans/' + id, options: { method: 'PATCH', credentials: 'same-origin', cache: 'no-store', redirect: 'error' } });
    expect(JSON.parse(String(requests[0]?.options?.body))).toEqual({ revision: 1, name: 'Changed' });
    await expect(client.call('updatePlan', { name: 'No revision' }, { planId: id })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it('loads every catalog page and validates each response', async () => {
    const urls: string[] = [];
    const client = createBillingClient(async path => {
      urls.push(String(path)); const offset = new URL(String(path), 'http://gym.test').searchParams.get('offset');
      return Response.json({ data: [plan], pagination: { offset: Number(offset), limit: 100, total: 2 } });
    });
    expect(await client.plans()).toHaveLength(2);
    expect(urls[1]).toContain('offset=1');
  });
  it('surfaces conflicts and rejects malformed server responses', async () => {
    const conflict = createBillingClient(async () => Response.json({}, { status: 409 }));
    await expect(conflict.call('getPlan', undefined, { planId: id })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const invalid = createBillingClient(async () => Response.json({ data: { amountCents: -1 } }));
    await expect(invalid.call('getPlan', undefined, { planId: id })).rejects.toThrow();
  });
});
describe('catalog decimal input', () => {
  it.each([['0', 2, 0], ['0.29', 2, 29], ['99.99', 2, 9999], ['8.875', 4, 88750], ['9.975', 4, 99750]])('parses %s exactly', (value, places, expected) => {
    expect(decimalUnits(value, places)).toBe(expected);
  });
  it.each(['-1', '1e2', '1.001', '21474836.48', 'NaN', ''])('rejects invalid cents %s', value => {
    expect(() => decimalUnits(value, 2)).toThrow();
  });
});
