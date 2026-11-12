// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { type MembersReportQuery, type MembersReportResponse } from '@plaingym/shared/contracts';
import { zonedInstant } from '@plaingym/shared/time';
import { membersHistory, type MembersHistory } from './members.query.js';
import { reportBuckets, type ReportContext } from './range.js';

interface Interval { start: number; end: number; imported: boolean }
interface Activity { live: Interval[]; frozen: Interval[]; unfrozen: Interval[] }
type Event = MembersHistory['events'][number];
function status(event: Event, snapshot: 'before' | 'after' = 'after'): unknown {
  return snapshot === 'before' ? event.beforeStatus
    : event.action === 'billing.membership.assigned' ? event.assignedStatus : event.afterStatus;
}
/** Touching memberships keep the member continuously active, including same-instant changes. */
function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  intervals.sort((a, b) => a.start - b.start || Number(a.imported) - Number(b.imported));
  for (const interval of intervals) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
function activity(history: MembersHistory, timezone: string): Activity[] {
  const events = new Map<string, Event[]>(), members = new Map<string, Activity>();
  for (const event of history.events) {
    const list = events.get(event.targetId) ?? [];
    list.push(event); events.set(event.targetId, list);
  }
  for (const row of history.rows) {
    const log = events.get(row.id) ?? [];
    // A freeze from `active` before any activation proves a seeded row was already active, so its
    // later resume is not the start of activity: such rows keep the starts_on fallback.
    const evidence = log.find(event => event.action === 'billing.membership.imported'
      || (event.action === 'billing.membership.activated' && status(event) === 'active')
      || (event.action === 'billing.membership.assigned' && status(event) === 'active')
      || (event.action === 'billing.membership.frozen' && status(event, 'before') === 'active'));
    const activation = evidence?.action === 'billing.membership.frozen' ? undefined : evidence;
    // Seed fallback cannot turn a known pending/trial membership into historical activity.
    const knownInactive = log.some(event => event.action === 'billing.membership.assigned'
      && ['pending', 'trial'].includes(String(status(event)))
      || event.action === 'billing.membership.frozen' && status(event, 'before') === 'trial');
    if (!evidence && (knownInactive || row.status !== 'active' && row.status !== 'frozen')) continue;
    const start = activation?.occurredAt.getTime()
      ?? zonedInstant(row.startsOn, '00:00', timezone, { gap: 'shift' })!.getTime();
    const end = row.cancelledAt?.getTime() ?? Infinity;
    if (start >= end) continue;
    const member = members.get(row.memberId) ?? { live: [], frozen: [], unfrozen: [] };
    member.live.push({ start, end, imported: activation?.action === 'billing.membership.imported' });
    let frozen: number | undefined, unfrozen = start;
    for (const event of log) {
      const instant = event.occurredAt.getTime();
      if (instant < start || instant >= end) continue;
      if (event.action === 'billing.membership.frozen' && frozen === undefined) {
        if (unfrozen < instant) member.unfrozen.push({ start: unfrozen, end: instant, imported: false });
        frozen = instant;
      }
      else if (event.action === 'billing.membership.activated' && frozen !== undefined) {
        if (frozen < instant) member.frozen.push({ start: frozen, end: instant, imported: false });
        frozen = undefined;
        unfrozen = instant;
      }
    }
    // Directly seeded frozen rows have no freeze event either.
    if (!log.length && row.status === 'frozen') {
      frozen = Math.max(start, row.frozenAt?.getTime() ?? start);
      if (start < frozen) member.unfrozen.push({ start, end: frozen, imported: false });
    }
    if (frozen !== undefined && frozen < end) member.frozen.push({ start: frozen, end, imported: false });
    if (frozen === undefined && unfrozen < end) member.unfrozen.push({ start: unfrozen, end, imported: false });
    members.set(row.memberId, member);
  }
  return [...members.values()].map(member => ({ live: union(member.live), frozen: union(member.frozen), unfrozen: union(member.unfrozen) }));
}
// Snapshots are immediately before the boundary; events exactly on it belong to the following month.
const present = (interval: Interval, boundary: number) => interval.start < boundary && interval.end >= boundary;

export function createMembersReportService(scope: typeof forGym = forGym) {
  return {
    async get(context: ReportContext, input: MembersReportQuery): Promise<MembersReportResponse> {
      const query = input, boundaries = reportBuckets(query, context);
      const history = await scope(context.gymId, tx => membersHistory(tx, context.gymId, new Date(boundaries[0]!.startsAt)));
      const members = activity(history, context.timezone);
      const buckets = boundaries.map(bucket => {
        const start = Date.parse(bucket.startsAt), end = Date.parse(bucket.endsAt);
        let activeAtStart = 0, added = 0, imported = 0, cancelled = 0, activeAtEnd = 0, frozenAtEnd = 0, churned = 0;
        for (const member of members) {
          const wasActive = member.live.some(interval => present(interval, start));
          if (wasActive) activeAtStart++;
          if (member.live.some(interval => present(interval, end))) activeAtEnd++;
          if (member.frozen.some(interval => present(interval, end)) && !member.unfrozen.some(interval => present(interval, end))) frozenAtEnd++;
          if (wasActive && member.live.some(interval => interval.end >= start && interval.end < end)) churned++;
          for (const interval of member.live) {
            if (interval.start >= start && interval.start < end) {
              if (interval.imported) imported++; else added++;
            }
            if (interval.end >= start && interval.end < end) cancelled++;
          }
        }
        return { ...bucket, activeAtStart, new: added, imported, cancelled, netChange: activeAtEnd - activeAtStart,
          activeAtEnd, frozenAtEnd, churn: activeAtStart ? { numerator: churned, denominator: activeAtStart } : null };
      });
      return { data: { ...query, timezone: context.timezone, buckets } };
    },
  };
}
