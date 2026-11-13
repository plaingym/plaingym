// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { applyPriceChange, createBillingClient, previewPriceChange } from './api.js';
import { decimalUnits } from './format.js';

const id = '019a0af0-9c00-7000-8000-000000000001';
const plan = { id, createdAt: '2026-10-23T12:00:00Z', name: 'Plan', currency: 'CAD', amountCents: 9999,
  interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
describe('billing contract transport', () => {
  it('validates a price preview including suppressed reach and counts', async () => {
    const preview = { plan, amountCents: 12000, effectiveOn: '2026-12-13', today: '2026-11-13', change: 'increase', memberships: [],
      total: 0, households: 0, householdsWithoutAddress: 0, householdsPayerErased: 0, householdsSuppressed: 0, switchesToPlan: 0, canEmail: true };
    const paths: string[] = [];
    const client = createBillingClient(async path => { paths.push(String(path)); return Response.json({ data: { ...preview, householdsSuppressed: -1 } }); });
    // The preview's plan is a strict subset of the catalog record.
    const { id: planId, name, amountCents, currency, interval, active, revision } = plan;
    const data = { ...preview, plan: { id: planId, name, amountCents, currency, interval, active, revision } };
    const valid = createBillingClient(async path => { paths.push(String(path)); return Response.json({ data }); });
    expect(await previewPriceChange(valid, id, 12000, preview.effectiveOn)).toEqual(data);
    expect(paths[0]).toBe('/api/billing/plans/' + id + '/price-change?amountCents=12000&effectiveOn=2026-12-13');
    await expect(previewPriceChange(client, id, 12000, preview.effectiveOn)).rejects.toThrow();
  });
  it('sends a stable price-change key and validates result counts and conflict reasons', async () => {
    const request = { requestKey: id, planRevision: 2, amountCents: 12000, effectiveOn: '2026-12-13', notify: true, memberships: [{ id, revision: 1 }] };
    const result = { planId: id, amountCents: 12000, effectiveOn: request.effectiveOn, scheduled: [id], skipped: [],
      householdsNotified: 0, householdsWithoutAddress: 0, householdsPayerErased: 0, householdsSuppressed: 1 };
    const bodies: unknown[] = [];
    const client = createBillingClient(async (_path, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({ data: result }); });
    expect(await applyPriceChange(client, id, request)).toEqual(result); await applyPriceChange(client, id, request);
    expect(bodies).toEqual([request, request]);
    const conflict = createBillingClient(async () => Response.json({ error: { details: { reason: ['request_reused'] } } }, { status: 409 }));
    await expect(applyPriceChange(conflict, id, request)).rejects.toMatchObject({ status: 409, reason: ['request_reused'] });
  });
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
  it('retains attachment reasons without exposing arbitrary server messages', async () => {
    const client = createBillingClient(async () => Response.json({ error: { code: 'conflict', message: 'Private SQL detail',
      details: { reason: ['tax_rate_attached'], plans: ['Plan'] } } }, { status: 409 }));
    await expect(client.call('updateTaxRate', { revision: 1, active: false }, { taxRateId: id }))
      .rejects.toMatchObject({ status: 409, code: 'conflict', reason: ['tax_rate_attached'], message: 'Request failed' });
  });
  it.each([null, {}, { error: null }, { error: { details: { reason: 'tax_rate_attached' } } },
    { error: { details: { reason: ['tax_rate_attached', 1] } } }])('ignores malformed reasons in %j', async body => {
    const client = createBillingClient(async () => Response.json(body, { status: 409 }));
    await expect(client.call('getTaxRate', undefined, { taxRateId: id })).rejects.toMatchObject({ status: 409, reason: [] });
  });
  it('retains status when an error body is not JSON', async () => {
    const client = createBillingClient(async () => new Response('Proxy failure', { status: 503 }));
    await expect(client.call('getTaxRate', undefined, { taxRateId: id })).rejects.toMatchObject({ status: 503, reason: [], message: 'Request failed' });
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
