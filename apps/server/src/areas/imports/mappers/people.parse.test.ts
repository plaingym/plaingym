// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { ImportTargetField } from '@plaingym/shared/contracts';
import { detectDateOrder, householdKey, knownKeys, lookupKeys, mapPerson, parseDate } from './people.parse.js';

const today = '2026-10-22';
function person(values: Partial<Record<ImportTargetField, string>>) {
  const data = { firstName: ' Jo ', lastName: 'Fields', ...values };
  return mapPerson({ rowNumber: 2, values: data }, Object.keys(data).map((field) => ({
    sourceColumn: field, targetField: field as ImportTargetField,
  })), { dateOrder: null, today });
}

describe('people cell mapping', () => {
  it.each([
    ['On Hold', 'frozen'], ['Paused', 'frozen'], ['Canceled', 'cancelled'], ['Inactive', 'cancelled'],
    ['Free Trial', 'trial'], ['Drop-in', 'visitor'], ['Lead', 'prospect'], ['Current', 'active'],
  ])('maps %s to %s', (source, status) => {
    expect(person({ status: source })).toMatchObject({ firstName: 'Jo', status, issues: [] });
  });
  it('keeps missing optional cells unset and deduplicates tags', () => {
    expect(person({ tags: 'Kids; kids|Morning, Adults', emailOptOut: 'NO' })).toMatchObject({
      email: null, dateOfBirth: null, status: null, emailOptOut: false, tags: ['Kids', 'Morning', 'Adults'], issues: [],
    });
  });
  it.each([
    { email: 'not-an-email' }, { status: 'unknown' }, { status: 'constructor' }, { status: '__proto__' },
    { emailOptOut: 'constructor' }, { emailOptOut: 'sometimes' }, { billingDay: '32' }, { billingDay: '1.5' },
    { stripeCustomerId: 'pm_wrong' }, { stripePaymentMethodId: '4242424242424242' }, { firstName: 'x'.repeat(201) },
  ])('reports invalid cells without echoing their contents: %j', (values) => {
    const result = person(values);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_value' })]));
    for (const value of Object.values(values)) expect(JSON.stringify(result.issues)).not.toContain(value);
  });
  it('rejects medical notes and fields belonging to other mappers', () => {
    const result = person({ medicalNotes: 'private diagnosis', emergencyContacts: 'private number', rank: 'advanced' });
    expect(result.issues).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('private diagnosis');
    expect(JSON.stringify(result)).not.toContain('private number');
  });
  it('requires both names', () => {
    expect(person({ firstName: '', lastName: '' }).issues.filter((issue) => issue.code === 'missing_required')).toHaveLength(2);
  });
});

describe('birth dates and duplicate identities', () => {
  it('infers a consistent date order from the whole file', () => {
    expect(detectDateOrder(['25/04/2012', '05/06/2014'])).toBe('dmy');
    expect(detectDateOrder(['04/25/2012', '05/06/2014'])).toBe('mdy');
    expect(detectDateOrder(['04/25/2012', '25/04/2012'])).toBeNull();
    expect(parseDate('05/06/2014', 'dmy', today)).toBe('2014-06-05');
    expect(parseDate('05/06/2014', null, today)).toBe('ambiguous');
  });
  it.each(['2013-02-29', '2027-01-01', '1899-12-31', '2020-01-01Tgarbage', '31/04/2012'])('rejects invalid birth date %s', (value) => {
    expect(parseDate(value, null, today)).toBe('invalid');
  });
  it('accepts leap days and unambiguous dates without relying on the host timezone', () => {
    expect(parseDate('2012-02-29', null, today)).toBe('2012-02-29');
    expect(parseDate('25/04/2012', null, today)).toBe('2012-04-25');
    expect(parseDate('04/25/2012', null, today)).toBe('2012-04-25');
  });
  it('includes names in email identities so siblings sharing an email stay separate', () => {
    const parent = person({ email: 'family@example.test' }), child = person({ firstName: 'Lee', email: 'family@example.test' });
    expect(lookupKeys(child).some((key) => knownKeys(parent).includes(key))).toBe(false);
    expect(lookupKeys(person({ firstName: 'JO', email: 'FAMILY@example.test' }))).toEqual(lookupKeys(parent));
  });
  it('flags a sparse identity when the other occurrence supplies an email, in either order', () => {
    const sparse = person({}), complete = person({ email: 'jo@example.test' });
    expect(lookupKeys(complete).some((key) => knownKeys(sparse).includes(key))).toBe(true);
    expect(lookupKeys(sparse).some((key) => knownKeys(complete).includes(key))).toBe(true);
  });
  it('keeps processor identifiers case-sensitive and does not group by surname alone', () => {
    const a = person({ stripeCustomerId: 'cus_Abc' }), b = person({ stripeCustomerId: 'cus_abc' });
    expect(householdKey(a)).not.toBe(householdKey(b));
    expect(householdKey(person({}))).not.toBe(householdKey({ ...person({}), rowNumber: 3 }));
  });
});
