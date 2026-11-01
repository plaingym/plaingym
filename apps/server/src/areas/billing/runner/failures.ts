// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { auditEvents, invoices, paymentAttempts, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { notFound, type MutationContext } from '../../../core/interfaces/common.js';
import { isProviderOutage } from '../../../infra/payments/index.js';
import { abandonedAttempt, recorded } from '../transitions/store.js';
import { audit } from './store.js';

/** Why a charge threw. Consecutive outages stop the daily run; a stopped run reports the other causes. */
export type ChargeFailureCause = 'provider_outage' | 'needs_reconciliation' | 'unexpected';
export interface ReportedFailure { invoiceId: string; number: number | null; cause: ChargeFailureCause; }
export interface ChargeFailureReport { runId: string; day: string; reportedAt: Date; failures: ReportedFailure[]; }
const reported = 'billing.runner.charge_failures.reported', dismissed = 'billing.runner.charge_failures.dismissed';
/** How long a report stays listed, like the failed jobs that showed these before. */
const reportDays = 90;

/** A provider answer the runner couldn't match to the invoice; reconciliation resolves the attempt by its ID. */
export class ReconciliationRequired extends Error {
  constructor() { super('Charge outcome requires reconciliation'); this.name = 'ReconciliationRequired'; }
}
export function failureCause(error: unknown): ChargeFailureCause {
  if (isProviderOutage(error)) return 'provider_outage';
  return error instanceof ReconciliationRequired ? 'needs_reconciliation' : 'unexpected';
}

/** One report per run: a replayed run keeps the report it wrote first. */
export async function reportChargeFailures(tx: Transaction, context: MutationContext, clock: Clock, runId: string, day: string,
  failures: readonly { invoiceId: string; cause: ChargeFailureCause }[]) {
  if (await recorded(tx, reported, runId)) return;
  const numbers = new Map((await tx.select({ id: invoices.id, number: invoices.number }).from(invoices)
    .where(inArray(invoices.id, failures.map(failure => failure.invoiceId)))).map(row => [row.id, row.number]));
  await audit(tx, context, clock, reported, 'charge_run', runId,
    { day, failures: failures.map(failure => ({ ...failure, number: numbers.get(failure.invoiceId) ?? null })) });
}

/**
 * The last 90 days' reports with the invoices that still need staff, oldest report first. An invoice leaves its report
 * once it is no longer open or past due, or once a later charge of it got the provider's answer (paid, declined or
 * awaiting authentication); a report leaves once staff dismiss it.
 */
export async function openChargeFailures(tx: Transaction, now: Date): Promise<ChargeFailureReport[]> {
  const reports = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, reported),
    gte(auditEvents.occurredAt, new Date(now.getTime() - reportDays * 86_400_000)),
    notInArray(auditEvents.targetId, tx.select({ id: auditEvents.targetId }).from(auditEvents).where(eq(auditEvents.action, dismissed)))))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  if (!reports.length) return [];
  const ids = [...new Set(reports.flatMap(row => (row.after as { failures: ReportedFailure[] }).failures.map(failure => failure.invoiceId)))];
  const statuses = new Map((await tx.select({ id: invoices.id, status: invoices.status }).from(invoices)
    .where(inArray(invoices.id, ids))).map(row => [row.id, row.status]));
  const answered = (await tx.select().from(paymentAttempts).where(and(inArray(paymentAttempts.invoiceId, ids),
    isNotNull(paymentAttempts.resolvedAt)))).filter(row => row.status !== 'pending' && !abandonedAttempt(row));
  return reports.map(row => {
    const { day, failures } = row.after as { day: string; failures: ReportedFailure[] };
    return { runId: row.targetId, day, reportedAt: row.occurredAt, failures: failures.filter(failure =>
      ['open', 'past_due'].includes(statuses.get(failure.invoiceId) ?? '')
        && !answered.some(attempt => attempt.invoiceId === failure.invoiceId && attempt.resolvedAt! >= row.occurredAt)) };
  }).filter(report => report.failures.length);
}

/** Staff dismiss what one report, or without `runId` every open report, still lists; the invoices are unchanged. */
export async function dismissChargeFailures(tx: Transaction, context: MutationContext, clock: Clock, runId?: string) {
  if (context.actor.kind !== 'user') throw new Error('Dismissing a charge failure report requires a user actor');
  if (runId !== undefined && !await recorded(tx, reported, runId)) notFound();
  const reports = (await openChargeFailures(tx, clock.now())).filter(row => runId === undefined || row.runId === runId);
  for (const report of reports) await audit(tx, context, clock, dismissed, 'charge_run', report.runId,
    { invoiceIds: report.failures.map(failure => failure.invoiceId) });
  return { dismissed: [...new Set(reports.flatMap(report => report.failures.map(failure => failure.invoiceId)))] };
}
