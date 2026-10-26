// SPDX-License-Identifier: AGPL-3.0-only
import { isCalendarDate } from '@plaingym/shared/time';
import type { ImportIssue, ImportPlanRequest, ImportTargetField } from '@plaingym/shared/contracts';
import { t } from '../pipeline.messages.js';
import type { CsvRow } from '../pipeline.csv.js';

export const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export interface Identity { email: string; firstName: string; lastName: string; dateOfBirth: string }
export interface Source {
  rowNumber: number; identity: Identity; plan: string; amountCents: number | null; currency: string;
  interval: 'monthly' | 'annual' | null; nextDueOn: string; billingDay: number | null; commitmentEndsOn: string | null;
  issues: ImportIssue[];
}
export const message = (key: string, values?: Record<string, string | number>) => t('imports/memberships:' + key, values);
/** An annual day can restore a clamped Feb 29. The database needs a valid leap-year date. */
export function annualAnniversary(nextDueOn: string, day: number | null): string | null {
  if (day === null || day === Number(nextDueOn.slice(8))) return nextDueOn;
  const year = Number(nextDueOn.slice(0, 4));
  if (day !== 29 || nextDueOn.slice(5) !== '02-28' || isCalendarDate(`${nextDueOn.slice(0, 4)}-02-29`)) return null;
  // The calculators use only month/day. Prefer the next leap year; at the upper date
  // boundary use the preceding one. Eight years also covers a non-leap century.
  for (const direction of [1, -1]) for (let offset = 1; offset <= 8; offset++) {
    const anchor = String(year + direction * offset).padStart(4, '0') + '-02-29';
    if (isCalendarDate(anchor)) return anchor;
  }
  return null;
}
export function parseMembership(row: CsvRow, plan: ImportPlanRequest): Source {
  const columns = new Map(plan.mapping.map(item => [item.targetField, item.sourceColumn]));
  const read = (field: ImportTargetField) => (row.values[columns.get(field) ?? ''] ?? '').trim();
  const issues: ImportIssue[] = [];
  const fail = (field: ImportTargetField, code: ImportIssue['code'], key: string) => issues.push({
    rowNumber: row.rowNumber, column: columns.get(field) ?? null, code, message: message(key),
  });
  const identity = { email: normalize(read('email')), firstName: normalize(read('firstName')),
    lastName: normalize(read('lastName')), dateOfBirth: read('dateOfBirth') };
  if (!identity.email && !(identity.firstName && identity.lastName)) fail('email', 'missing_required', 'missingMember');
  if (identity.dateOfBirth && !isCalendarDate(identity.dateOfBirth)) fail('dateOfBirth', 'invalid_value', 'invalidDate');
  if (!read('plan')) fail('plan', 'missing_required', 'missingPlan');
  const nextDueOn = read('nextDueOn');
  if (!nextDueOn) fail('nextDueOn', 'missing_required', 'missingDueDate');
  else if (!isCalendarDate(nextDueOn)) fail('nextDueOn', 'invalid_value', 'invalidDate');
  const price = read('amountCents');
  const amountCents = price ? Number(price) : null;
  if (price && (!/^\d+$/.test(price) || !Number.isSafeInteger(amountCents) || amountCents! > 2147483647))
    fail('amountCents', 'invalid_value', 'invalidPrice');
  const interval = normalize(read('interval'));
  if (interval && interval !== 'monthly' && interval !== 'annual') fail('interval', 'invalid_value', 'invalidInterval');
  const currency = read('currency').toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail('currency', 'invalid_value', 'invalidCurrency');
  const day = read('billingDay'), billingDay = day ? Number(day) : null;
  if (day && (!/^\d{1,2}$/.test(day) || billingDay! < 1 || billingDay! > 31)) fail('billingDay', 'invalid_value', 'invalidDay');
  const commitmentEndsOn = read('commitmentEndsOn') || null;
  if (commitmentEndsOn && !isCalendarDate(commitmentEndsOn)) fail('commitmentEndsOn', 'invalid_value', 'invalidDate');
  // Imported renewals are already active. Trial and freeze metadata need a staff lifecycle action.
  const status = normalize(read('status'));
  if (status && status !== 'active') fail('status', 'invalid_value', 'invalidStatus');
  return { rowNumber: row.rowNumber, identity, plan: read('plan'), amountCents, currency,
    interval: interval === 'monthly' || interval === 'annual' ? interval : null, nextDueOn, billingDay, commitmentEndsOn, issues };
}
