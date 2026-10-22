// SPDX-License-Identifier: AGPL-3.0-only
import { CronExpressionParser } from 'cron-parser';

export function validateCron(expression: string): void {
  if (expression.trim().split(/\s+/).length !== 5 || /H/.test(expression))
    throw new Error('Expected a deterministic five-field cron expression');
  CronExpressionParser.parse(expression, { currentDate: new Date('2026-01-01Z'), tz: 'UTC' });
}

/** A repeated wall-clock minute is one occurrence, including during fall-back. */
export function occurrenceKey(time: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(time);
}

/** Spring-forward occurrences run at the parser's first valid shifted time. */
export function* cronOccurrences(expression: string, timezone: string, after: Date, until: Date): Generator<Date> {
  const interval = CronExpressionParser.parse(expression, { currentDate: after, tz: timezone });
  while (true) {
    const next = interval.next().toDate();
    if (next > until) return;
    yield next;
  }
}
