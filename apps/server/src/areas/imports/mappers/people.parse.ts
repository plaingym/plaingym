// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { memberStatusSchema, type ImportColumnMapping, type ImportIssue, type ImportTargetField } from '@plaingym/shared/contracts';
import { t } from '../pipeline.messages.js';
import { duplicateKey, type CsvRow } from '../pipeline.csv.js';

export type MemberStatus = z.infer<typeof memberStatusSchema>;
/** One source row mapped to people fields; null means the cell was empty, unmapped or invalid. */
export interface Person {
  rowNumber: number; externalId: string | null; firstName: string | null; lastName: string | null; email: string | null;
  dateOfBirth: string | null; status: MemberStatus | null; phone: string | null; householdExternalId: string | null;
  householdName: string | null; billingDay: number | null; emailOptOut: boolean | null; tags: string[];
  stripeCustomerId: string | null; stripePaymentMethodId: string | null; issues: ImportIssue[];
}
/** Fields this mapper writes. Medical notes and PINs are never imported. */
export const peopleFields: ReadonlySet<ImportTargetField> = new Set<ImportTargetField>([
  'externalId', 'firstName', 'lastName', 'email', 'dateOfBirth', 'status', 'phone', 'householdExternalId',
  'householdName', 'billingDay', 'emailOptOut', 'tags', 'stripeCustomerId', 'stripePaymentMethodId',
]);
const maxLength: Partial<Record<ImportTargetField, number>> = { email: 320, phone: 64, tags: 2000 };
const MAX_TEXT = 200, MAX_TAG = 100;
const word = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');
// Common labels from other gym software; anything else is reported, never guessed.
const statuses: Record<string, MemberStatus> = {
  prospect: 'prospect', lead: 'prospect', inquiry: 'prospect', enquiry: 'prospect',
  trial: 'trial', trialing: 'trial', trialist: 'trial', freetrial: 'trial', intrial: 'trial',
  active: 'active', current: 'active',
  frozen: 'frozen', freeze: 'frozen', onhold: 'frozen', hold: 'frozen', paused: 'frozen', suspended: 'frozen',
  cancelled: 'cancelled', canceled: 'cancelled', inactive: 'cancelled', former: 'cancelled', expired: 'cancelled', terminated: 'cancelled',
  visitor: 'visitor', guest: 'visitor', dropin: 'visitor',
};
const booleans: Record<string, boolean> = { yes: true, y: true, true: true, '1': true, no: false, n: false, false: false, '0': false };
const email = z.email();
const customerId = /^cus_[A-Za-z0-9]{1,250}$/;
const paymentMethodId = /^(?:pm|card|ba|src)_[A-Za-z0-9]{1,250}$/;

export type DateOrder = 'dmy' | 'mdy' | null;
const isoDate = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const localDate = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
/** A file is day-first or month-first when some unambiguous date says so and none says otherwise. */
export function detectDateOrder(values: Iterable<string>): DateOrder {
  let dmy = false, mdy = false;
  for (const value of values) {
    const match = localDate.exec(value.trim());
    if (!match) continue;
    if (Number(match[1]) > 12) dmy = true;
    if (Number(match[2]) > 12) mdy = true;
  }
  return dmy === mdy ? null : dmy ? 'dmy' : 'mdy';
}
/** Returns an ISO date, or why the value can't be used. Dates after `today` or before 1900 are invalid. */
export function parseDate(value: string, order: DateOrder, today: string): string | 'invalid' | 'ambiguous' {
  let year: number, month: number, day: number;
  const iso = isoDate.exec(value);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const local = localDate.exec(value);
    if (!local) return 'invalid';
    const first = Number(local[1]), second = Number(local[2]);
    const resolved = order ?? (first > 12 ? 'dmy' : second > 12 || first === second ? 'mdy' : null);
    if (!resolved) return 'ambiguous';
    year = Number(local[3]);
    [day, month] = resolved === 'dmy' ? [first, second] : [second, first];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return 'invalid';
  const text = date.toISOString().slice(0, 10);
  return text > today ? 'invalid' : text;
}

export interface ParseOptions { dateOrder: DateOrder; today: string }
export function mapPerson(row: CsvRow, mapping: readonly ImportColumnMapping[], options: ParseOptions): Person {
  const columns = new Map(mapping.map((item) => [item.targetField, item.sourceColumn]));
  const issues: ImportIssue[] = [];
  const issue = (field: ImportTargetField, code: ImportIssue['code'], key: string) =>
    issues.push({ rowNumber: row.rowNumber, column: columns.get(field) ?? null, code, message: t('imports/people:' + key) });
  for (const { sourceColumn, targetField } of mapping) if (!peopleFields.has(targetField)) issues.push({ rowNumber: row.rowNumber,
    column: sourceColumn, code: 'invalid_value', message: t(targetField === 'medicalNotes' ? 'imports/people:medicalNotes' : 'imports/people:unsupportedField') });
  const text = (field: ImportTargetField): string | null => {
    const source = columns.get(field), value = source === undefined ? '' : (row.values[source] ?? '').normalize('NFC').trim();
    if (value.length > (maxLength[field] ?? MAX_TEXT)) { issue(field, 'invalid_value', 'tooLong'); return null; }
    return value || null;
  };
  const parsed = <T>(field: ImportTargetField, parse: (value: string) => T | undefined, key: string): T | null => {
    const value = text(field);
    if (value === null) return null;
    const result = parse(value);
    if (result === undefined) { issue(field, 'invalid_value', key); return null; }
    return result;
  };
  const firstName = text('firstName'), lastName = text('lastName');
  if (!firstName) issue('firstName', 'missing_required', 'required');
  if (!lastName) issue('lastName', 'missing_required', 'required');
  const dateOfBirth = (() => {
    const value = text('dateOfBirth');
    if (value === null) return null;
    const result = parseDate(value, options.dateOrder, options.today);
    if (result === 'invalid' || result === 'ambiguous') { issue('dateOfBirth', 'invalid_value', result === 'invalid' ? 'invalidDate' : 'ambiguousDate'); return null; }
    return result;
  })();
  const tags = parsed('tags', (value) => {
    const names = new Map<string, string>();
    for (const name of value.split(/[;,|]/).map((item) => item.trim()).filter(Boolean)) {
      if (name.length > MAX_TAG) return undefined;
      if (!names.has(tagKey(name))) names.set(tagKey(name), name);
    }
    return [...names.values()];
  }, 'tooLong') ?? [];
  return {
    rowNumber: row.rowNumber, externalId: text('externalId'), firstName, lastName,
    email: parsed('email', (value) => email.safeParse(value).success ? value : undefined, 'invalidEmail'),
    dateOfBirth, status: parsed('status', (value) => Object.hasOwn(statuses, word(value)) ? statuses[word(value)] : undefined, 'invalidStatus'), phone: text('phone'),
    householdExternalId: text('householdExternalId'), householdName: text('householdName'),
    billingDay: parsed('billingDay', (value) => /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 31 ? Number(value) : undefined, 'invalidBillingDay'),
    emailOptOut: parsed('emailOptOut', (value) => Object.hasOwn(booleans, value.toLowerCase()) ? booleans[value.toLowerCase()] : undefined, 'invalidBoolean'), tags,
    stripeCustomerId: parsed('stripeCustomerId', (value) => customerId.test(value) ? value : undefined, 'invalidCustomer'),
    stripePaymentMethodId: parsed('stripePaymentMethodId', (value) => paymentMethodId.test(value) ? value : undefined, 'invalidPaymentMethod'),
    issues,
  };
}
export const tagKey = (name: string) => name.normalize('NFKC').trim().toLowerCase();

interface Identity { externalId?: string | null; firstName: string | null; lastName: string | null; email: string | null; dateOfBirth: string | null }
/**
 * Keys under which a person can be found: a source row or an existing member. Names alone
 * identify only rows that carry neither an email nor a birth date (see `lookupKeys`). Family
 * members often share an email, so every email and birth-date key includes the name.
 */
export function knownKeys(person: Identity): string[] {
  const keys: (string | null)[] = [person.externalId ? JSON.stringify(['externalId', person.externalId]) : null];
  if (person.firstName && person.lastName) {
    const name = [person.firstName, person.lastName];
    keys.push(duplicateKey(['name', ...name]));
    if (!person.email && !person.dateOfBirth) keys.push(duplicateKey(['weakname', ...name]));
    if (person.email) keys.push(duplicateKey(['email', ...name, person.email]));
    if (person.dateOfBirth) keys.push(duplicateKey(['dob', ...name, person.dateOfBirth]));
  }
  return keys.filter((key): key is string => key !== null);
}
/** Keys that identify a duplicate of this row. */
export function lookupKeys(person: Identity): string[] {
  const keys = knownKeys(person).filter((key) => !key.startsWith('["name"') || (!person.email && !person.dateOfBirth));
  if ((person.email || person.dateOfBirth) && person.firstName && person.lastName)
    keys.push(duplicateKey(['weakname', person.firstName, person.lastName])!);
  return keys;
}
/**
 * Rows join a household by the household's external ID, or by their own external ID (a
 * primary member's ID is often the family reference), or by a shared Stripe customer.
 */
export function householdKey(person: Pick<Person, 'rowNumber' | 'householdExternalId' | 'externalId' | 'stripeCustomerId'>): string {
  const reference = person.householdExternalId ?? person.externalId;
  if (reference) return JSON.stringify(['household', reference]);
  if (person.stripeCustomerId) return JSON.stringify(['customer', person.stripeCustomerId]);
  return 'row:' + person.rowNumber;
}
