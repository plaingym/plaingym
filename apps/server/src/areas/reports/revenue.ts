// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { type ReportBucket, type RevenueGroup, type RevenueReportQuery, type RevenueReportResponse } from '@plaingym/shared/contracts';
import { allocatePayment, allocateRevenue } from './revenue.allocation.js';
import { readRevenue, type RevenueData } from './revenue.query.js';
import { reportBuckets, type ReportContext } from './range.js';

type Group = Pick<RevenueGroup, 'kind' | 'id' | 'name'>;
function groupFor({ line, planId, planName, chargeName, taxName, packId, packName }: RevenueData['lines'][number]): Group {
  switch (line.kind) {
    case 'membership': return { kind: 'plan', id: planId, name: planName };
    case 'signup_fee': return { kind: 'signup_fee', id: planId, name: planName };
    case 'charge': return line.chargeTypeId ? { kind: 'charge_type', id: line.chargeTypeId, name: chargeName }
      : packId ? { kind: 'class_pack', id: packId, name: packName } : { kind: 'other', id: null, name: null };
    case 'discount': return { kind: 'discount', id: null, name: null };
    case 'tax': return { kind: 'tax', id: line.taxRateId, name: taxName ?? line.description };
    default: throw new Error('Unknown revenue line kind');
  }
}
const unapplied: Group = { kind: 'unapplied', id: null, name: null };
const groupKey = (group: Group) => `${group.kind}:${group.id ?? (group.kind === 'tax' ? group.name : '')}`;
const zeroTotals = () => ({ payments: 0, refunds: 0, net: 0, netBeforeTax: 0, netTax: 0 });
function add(a: number, b: number) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new RangeError('Revenue exceeds safe integer minor units');
  return result;
}

/** Pure assembly also keeps currencies separate for historical/imported datasets. */
export function buildRevenueReport(data: RevenueData, boundaries: readonly ReportBucket[]): RevenueReportResponse['data']['currencies'] {
  const currencies = new Map<string, RevenueReportResponse['data']['currencies'][number]>();
  const bounds = boundaries.map(bucket => ({ start: Date.parse(bucket.startsAt), end: Date.parse(bucket.endsAt) }));
  const bucketGroups = new Map<RevenueReportResponse['data']['currencies'][number]['buckets'][number], Map<string, RevenueGroup>>();
  const linesByInvoice = new Map<string, RevenueData['lines']>();
  for (const row of data.lines) {
    const rows = linesByInvoice.get(row.line.invoiceId) ?? [];
    rows.push(row); linesByInvoice.set(row.line.invoiceId, rows);
  }
  const rejected = new Set(data.markers.filter(row => row.after !== null && typeof row.after === 'object'
    && 'accepted' in row.after && row.after.accepted === false).map(row => row.paymentId));
  const partsByPayment = new Map<string, ReturnType<typeof allocatePayment>>();
  const groups = new Map<string, Group>([['unapplied', unapplied]]);
  for (const row of data.lines) groups.set(row.line.id, groupFor(row));
  function paymentParts(row: RevenueData['received'][number]) {
    let parts = partsByPayment.get(row.payment.id);
    if (!parts) {
      const lines = linesByInvoice.get(row.payment.invoiceId) ?? [];
      parts = allocatePayment(row.payment.amountCents, row.invoiceAmount,
        lines.map(({ line }) => ({ id: line.id, amount: line.amountCents })), !rejected.has(row.payment.id));
      partsByPayment.set(row.payment.id, parts);
    }
    return parts;
  }
  function record(row: RevenueData['received'][number], instant: number, values: ReturnType<typeof allocatePayment>, refundAmount?: number) {
    const bucketIndex = bounds.findIndex(bucket => instant >= bucket.start && instant < bucket.end);
    if (bucketIndex < 0) return;
    let currency = currencies.get(row.payment.currency);
    if (!currency) {
      currency = { currency: row.payment.currency, buckets: boundaries.map(bucket => ({ ...bucket, groups: [], totals: zeroTotals() })) };
      currencies.set(currency.currency, currency);
    }
    const bucket = currency.buckets[bucketIndex]!;
    let index = bucketGroups.get(bucket);
    if (!index) { index = new Map(); bucketGroups.set(bucket, index); }
    const field = refundAmount === undefined ? 'payments' : 'refunds';
    for (const part of values) {
      if (!part.amount) continue;
      const identity = groups.get(part.id)!;
      const key = groupKey(identity);
      let group = index.get(key);
      if (!group) { group = { ...identity, payments: 0, refunds: 0, net: 0 }; bucket.groups.push(group); index.set(key, group); }
      group[field] = add(group[field], part.amount);
      group.net = add(group.payments, -group.refunds);
    }
    bucket.totals[field] = add(bucket.totals[field], refundAmount ?? row.payment.amountCents);
  }
  for (const row of data.received) record(row, row.payment.paidAt.getTime(), paymentParts(row));
  const events = data.returned.flatMap(row => {
    const success = row.originalResolvedAt ? new Date(row.originalResolvedAt) : row.refund.resolvedAt;
    // A reversal never precedes its own success, even if a clock stepped back between them; the running total stays nonnegative.
    return success ? [{ row, instant: success.getTime(), amount: row.refund.amountCents, reversal: false },
      ...(row.reversedAt ? [{ row, instant: Math.max(row.reversedAt.getTime(), success.getTime()),
        amount: -row.refund.amountCents, reversal: true }] : [])] : [];
  }).sort((a, b) => a.instant - b.instant || a.row.refund.id.localeCompare(b.row.refund.id) || Number(a.reversal) - Number(b.reversal));
  const running = new Map<string, { amount: number; values: ReturnType<typeof allocatePayment> }>();
  for (const { row, instant, amount } of events) {
    const parts = paymentParts(row), previous = running.get(row.payment.id);
    const total = add(previous?.amount ?? 0, amount), values = allocateRevenue(total, parts);
    const before = new Map(previous?.values.map(part => [part.id, part.amount]));
    record(row, instant, values.map(part => ({ ...part, amount: add(part.amount, -(before.get(part.id) ?? 0)) })), amount);
    running.set(row.payment.id, { amount: total, values });
  }
  for (const currency of currencies.values()) for (const bucket of currency.buckets) {
    bucket.groups.sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
    bucket.totals.net = add(bucket.totals.payments, -bucket.totals.refunds);
    bucket.totals.netTax = bucket.groups.filter(group => group.kind === 'tax').reduce((sum, group) => add(sum, group.net), 0);
    bucket.totals.netBeforeTax = add(bucket.totals.net, -bucket.totals.netTax);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function createRevenueReportService(scope: typeof forGym = forGym) {
  return {
    async get(context: ReportContext, input: RevenueReportQuery): Promise<RevenueReportResponse> {
      const query = input, boundaries = reportBuckets(query, context);
      const data = await scope(context.gymId, tx => readRevenue(tx, context.gymId,
        new Date(boundaries[0]!.startsAt), new Date(boundaries.at(-1)!.endsAt)));
      return { data: { ...query, timezone: context.timezone, currencies: buildRevenueReport(data, boundaries) } };
    },
  };
}
