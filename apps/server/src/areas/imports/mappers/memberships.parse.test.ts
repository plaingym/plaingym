// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { ImportPlanRequest, ImportTargetField } from '@plaingym/shared/contracts';
import { annualAnniversary, parseMembership } from './memberships.parse.js';

function parse(overrides: Record<string, string> = {}) {
  const values = { email: 'member@example.test', plan: 'Standard', nextDueOn: '2028-02-29', ...overrides };
  const plan: ImportPlanRequest = { uploadId: '00000000-0000-7000-8000-000000000001', mapper: 'memberships', duplicatePolicy: 'error',
    mapping: Object.keys(values).map(field => ({ sourceColumn: field, targetField: field as ImportTargetField })) };
  return parseMembership({ rowNumber: 2, values }, plan);
}
describe('membership CSV cells', () => {
  it.each([
    ['2027-02-28', '2028-02-29'], ['2097-02-28', '2104-02-29'], ['9999-02-28', '9996-02-29'],
  ])('represents the inferred February 29 for %s with the valid leap date %s', (due, expected) => {
    expect(annualAnniversary(due, 29)).toBe(expected);
  });
  it('preserves calendar dates and accepts integer cents, zero prices and normalized intervals', () => {
    expect(parse({ amountCents: '0', interval: ' Annual ', currency: 'cad' })).toMatchObject({
      amountCents: 0, interval: 'annual', currency: 'CAD', nextDueOn: '2028-02-29', issues: [],
    });
    expect(parse().amountCents).toBeNull();
    expect(parse({ firstName: 'Ari', lastName: 'Stone', email: '' }).issues).toEqual([]);
  });
  it.each([
    ['nextDueOn', '2027-02-29'], ['nextDueOn', '2028-03-01T00:00:00Z'], ['nextDueOn', '03/01/2028'],
    ['amountCents', '-1'], ['amountCents', '10.50'], ['amountCents', '1e3'], ['amountCents', '2147483648'],
    ['interval', 'weekly'], ['currency', 'dollars'], ['billingDay', '32'], ['billingDay', '0'],
    ['commitmentEndsOn', '2028-02-30'], ['dateOfBirth', '2000-13-01'], ['status', 'frozen'],
    ['email', ''], ['plan', ''], ['nextDueOn', ''],
  ])('rejects invalid or missing %s: %s', (field, value) => {
    const result = parse({ [field]: value });
    expect(result.issues).toEqual([expect.objectContaining({ column: field, rowNumber: 2 })]);
    expect(result.issues[0]!.message).not.toContain('imports/memberships:');
  });
});
