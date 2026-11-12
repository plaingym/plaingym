// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { reportBuckets } from './range.js';

const context = { gymId: 'unused', timezone: 'America/New_York', clock: new TestClock('2026-11-15T12:00:00Z') };
describe('report calendar buckets', () => {
  it.each(['month', 'week'] as const)('marks only the current %s in progress with exclusive ends', granularity => {
    const local = { ...context, clock: new TestClock('2026-11-01T04:30:00Z') };
    const buckets = reportBuckets({ from: '2026-11', to: '2026-11' }, local, granularity);
    expect(buckets.filter(bucket => bucket.inProgress)).toHaveLength(1);
    expect(buckets.find(bucket => bucket.inProgress)).toMatchObject({ startDate: '2026-11-01', partial: granularity === 'week' });
    expect(buckets.filter(bucket => bucket.startDate < '2026-11-01' || bucket.startDate > '2026-11-01')
      .every(bucket => !bucket.inProgress)).toBe(true);
    expect(reportBuckets({ from: '2026-10', to: '2026-10' }, local, granularity).every(bucket => !bucket.inProgress)).toBe(true);
    const atEnd = reportBuckets({ from: '2026-11', to: '2026-11' }, {
      ...local, clock: new TestClock(granularity === 'week' ? '2026-11-02T05:00:00Z' : '2026-12-01T05:00:00Z'),
    }, granularity);
    expect(atEnd[0]!.inProgress).toBe(false);
  });
  it('steps monthly through both DST changes and a year boundary', () => {
    const buckets = reportBuckets({ from: '2025-12', to: '2026-11' }, context);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]).toMatchObject({ startDate: '2025-12-01', endDate: '2026-01-01', partial: false });
    expect(buckets[3]).toMatchObject({ startsAt: '2026-03-01T05:00:00.000Z', endsAt: '2026-04-01T04:00:00.000Z' });
    expect(buckets[11]).toMatchObject({ startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-12-01T05:00:00.000Z' });
  });
  it.each([
    ['2026-03', '2026-03-02', 167], ['2026-10', '2026-10-26', 169],
  ])('has calendar Monday weeks across DST in %s', (month, monday, hours) => {
    const buckets = reportBuckets({ from: month, to: month === '2026-10' ? '2026-11' : month }, context, 'week');
    const week = buckets.find(bucket => bucket.startDate === monday)!;
    expect((Date.parse(week.endsAt) - Date.parse(week.startsAt)) / 3_600_000).toBe(hours);
    expect(week.partial).toBe(false);
    expect(buckets[0]).toMatchObject({ startDate: month + '-01', partial: true });
    expect(buckets.at(-1)!.partial).toBe(true);
  });
  it('does not mark complete boundary weeks partial', () => {
    const buckets = reportBuckets({ from: '2026-06', to: '2026-06' }, context, 'week');
    expect(buckets[0]).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-08', partial: false });
  });
  it('shifts a nonexistent local midnight through the shared time helper', () => {
    expect(reportBuckets({ from: '2014-08', to: '2014-08' }, { ...context, timezone: 'Africa/Cairo' })[0])
      .toMatchObject({ startsAt: '2014-07-31T22:00:00.000Z' });
  });
  it.each([
    { from: '2024-11', to: '2026-11' }, { from: '2026-12', to: '2026-11' }, { from: '2026-11', to: '2026-12' },
  ])('rejects an invalid or future range before SQL: %j', input => {
    expect(() => reportBuckets(input, context)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('compares the future limit to the gym-local month, not the UTC month', () => {
    const boundary = { ...context, clock: new TestClock('2026-12-01T00:30:00Z') };
    expect(() => reportBuckets({ from: '2026-12', to: '2026-12' }, boundary)).toThrow(expect.objectContaining({ status: 400 }));
    expect(reportBuckets({ from: '2026-11', to: '2026-11' }, boundary)).toHaveLength(1);
    expect(reportBuckets({ from: '2026-12', to: '2026-12' }, { ...boundary, timezone: 'Asia/Tokyo' })).toHaveLength(1);
  });
});
