// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type Clock } from '@plaingym/shared';
import { reportRangeQuerySchema, type ReportBucket, type ReportRangeQuery } from '@plaingym/shared/contracts';
import { addDays, localDate, localMidnight, nextMonth, startOfWeek } from '@plaingym/shared/time';

export interface ReportContext { readonly gymId: string; readonly timezone: string; readonly clock: Clock }
const midnight = (date: string, timezone: string) => localMidnight(date, timezone).toISOString();

/** Local calendar buckets converted to instants once; SQL compares instants only. */
export function reportBuckets(input: ReportRangeQuery, context: ReportContext, granularity: 'week' | 'month' = 'month'): ReportBucket[] {
  const query = reportRangeQuerySchema.safeParse(input);
  if (!query.success) throw new AppError('invalid_request', 'Invalid report month range');
  const now = context.clock.now();
  if (query.data.to > localDate(now, context.timezone).slice(0, 7))
    throw new AppError('invalid_request', 'Report range ends after the current local month');
  const from = query.data.from + '-01', end = nextMonth(query.data.to + '-01');
  const buckets: ReportBucket[] = [];
  let cursor = from;
  while (cursor < end) {
    const naturalStart = granularity === 'week' ? startOfWeek(cursor) : cursor;
    const naturalEnd = granularity === 'week' ? addDays(naturalStart, 7) : nextMonth(cursor);
    const finish = naturalEnd < end ? naturalEnd : end;
    const startsAt = midnight(cursor, context.timezone), endsAt = midnight(finish, context.timezone);
    buckets.push({ startDate: cursor, endDate: finish, startsAt, endsAt,
      partial: cursor !== naturalStart || finish !== naturalEnd,
      inProgress: new Date(startsAt) <= now && now < new Date(endsAt) });
    cursor = finish;
  }
  return buckets;
}
