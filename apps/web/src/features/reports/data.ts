// SPDX-License-Identifier: AGPL-3.0-only
import { minorUnitsToInput } from '@plaingym/shared/money';
import { localDate } from '@plaingym/shared/time';
import type { AttendanceReportResponse, MembersReportResponse, RevenueReportResponse, ReportRangeQuery, ReportBucket } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';

export const text = (key: string, values?: Record<string, string | number>) => t('reports/screens:' + key, values);
export interface ReportTable { columns: string[]; rows: string[][]; textColumns?: number[] }
export function defaultRange(timezone: string, now = new Date()): ReportRangeQuery {
  const to = localDate(now, timezone).slice(0, 7);
  const month = Number(to.slice(0, 4)) * 12 + Number(to.slice(5)) - 1 - 11;
  return { from: `${Math.floor(month / 12).toString().padStart(4, '0')}-${(month % 12 + 1).toString().padStart(2, '0')}`, to };
}
/** A churn ratio as a percentage with two decimals; the same text on screen and in the CSV file. */
const churnPercent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const periodColumns = () => [text('start'), text('end'), text('periodStatus')];
const period = (bucket: ReportBucket, today: string) => {
  const status = bucket.inProgress ? 'inProgress' : bucket.startDate > today ? 'upcoming' : bucket.partial ? 'partial' : 'complete';
  return [bucket.startDate, bucket.endDate, text(bucket.partial && (status === 'inProgress' || status === 'upcoming') ? status + 'Partial' : status)];
};
export function membersTable(data: MembersReportResponse['data'], now = new Date()): ReportTable {
  const today = localDate(now, data.timezone);
  return { columns: [...periodColumns(), ...['activeAtStart', 'new', 'imported', 'cancelled', 'netChange', 'activeAtEnd', 'frozenAtEnd', 'churn'].map(key => text(key))],
    rows: data.buckets.map(bucket => [...period(bucket, today), ...[bucket.activeAtStart, bucket.new, bucket.imported, bucket.cancelled,
      bucket.netChange, bucket.activeAtEnd, bucket.frozenAtEnd].map(String), bucket.churn
      ? churnPercent.format(bucket.churn.numerator / bucket.churn.denominator) : text('notAvailable')]) };
}
export const allPrograms = 'all';
export const unassignedProgram = 'unassigned';
export const programKey = (programId: string | null) => programId ?? unassignedProgram;
export function attendanceTable(data: AttendanceReportResponse['data'], selected = allPrograms, now = new Date()): ReportTable {
  const today = localDate(now, data.timezone);
  const selectedName = data.buckets.flatMap(bucket => bucket.programs).find(program => programKey(program.programId) === selected)?.programName ?? text('unassigned');
  return { columns: [...periodColumns(), text('program'), text('checkIns'), text('uniqueMembers')], textColumns: [3],
    rows: data.buckets.flatMap(bucket => {
      const programs = bucket.programs.filter(program => selected === allPrograms || programKey(program.programId) === selected);
      if (selected !== allPrograms) {
        const counts = programs[0];
        return [[...period(bucket, today), selectedName, String(counts?.checkIns ?? 0), String(counts?.uniqueMembers ?? 0)]];
      }
      return [[...period(bucket, today), text('allPrograms'), String(bucket.totals.checkIns), String(bucket.totals.uniqueMembers)],
        ...programs.map(program => [...period(bucket, today), program.programName ?? text('unassigned'), String(program.checkIns), String(program.uniqueMembers)]) ];
    }) };
}
export function revenueTable(data: RevenueReportResponse['data']['currencies'][number], timezone: string, now = new Date()): ReportTable {
  const today = localDate(now, timezone);
  const amount = (value: number) => minorUnitsToInput(value, data.currency);
  return { columns: [...periodColumns(), text('currency'), text('groupType'), text('group'), text('payments'), text('refunds'), text('net')], textColumns: [5],
    rows: data.buckets.flatMap(bucket => [
      ...bucket.groups.map(group => [...period(bucket, today), data.currency, text(group.kind), group.name ?? text(group.kind),
        amount(group.payments), amount(group.refunds), amount(group.net)]),
      [...period(bucket, today), data.currency, text('total'), text('total'), amount(bucket.totals.payments), amount(bucket.totals.refunds), amount(bucket.totals.net)],
    ]) };
}
