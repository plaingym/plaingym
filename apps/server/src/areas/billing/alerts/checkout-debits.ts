// SPDX-License-Identifier: AGPL-3.0-only
import { and, countDistinct, eq, exists, isNotNull, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Extract the Checkout intent ID from gym-scoped audits to match payments and late debit resolutions.
import { sql } from 'drizzle-orm';
import { auditEvents, forGym, invoices, payments } from '@plaingym/db';
import { AppError, canStaff } from '@plaingym/shared';
import { extensionDashboardWidgetSchema } from '@plaingym/shared/contracts';
import type { z } from 'zod';
import type { DashboardWidgetProvider } from '../../../core/interfaces/extensions.js';
import { checkoutReviewAction, lateProcessingResolved } from '../runner/reconciliation.js';
import { invoiceLateProcessing } from '../transitions/bank.js';

export function createCheckoutDebitReviewProvider(options: { scope?: typeof forGym } = {}): DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym;
  return { id: 'billing.checkout_debits', permission: 'billing.read', order: 41, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'billing.read')) throw new AppError('forbidden', 'Access denied');
      const [total] = await scope(context.gymId, tx => {
        const auditedIntentId = sql<string>`${auditEvents.after}->>'paymentIntentId'`;
        const findings = tx.select({ invoiceId: auditEvents.targetId, intentId: auditedIntentId.as('checkout_review_intent_id') })
          .from(auditEvents).where(and(eq(auditEvents.gymId, context.gymId), eq(auditEvents.targetType, 'invoice'),
            eq(auditEvents.action, checkoutReviewAction), isNotNull(auditedIntentId))).as('checkout_review_findings');
        const matchingAudit = and(eq(auditEvents.gymId, invoices.gymId), eq(auditEvents.targetType, 'invoice'),
          eq(auditEvents.targetId, invoices.id), eq(auditedIntentId, findings.intentId));
        const late = tx.select({ id: auditEvents.id }).from(auditEvents)
          .where(and(matchingAudit, eq(auditEvents.action, invoiceLateProcessing)));
        const resolved = tx.select({ id: auditEvents.id }).from(auditEvents)
          .where(and(matchingAudit, eq(auditEvents.action, lateProcessingResolved)));
        const paid = tx.select({ id: payments.id }).from(payments)
          .where(and(eq(payments.gymId, invoices.gymId), eq(payments.paymentIntentId, findings.intentId)));
        return tx.select({ count: countDistinct(invoices.id) }).from(invoices)
          .innerJoin(findings, eq(findings.invoiceId, invoices.id))
          .where(and(eq(invoices.gymId, context.gymId), notExists(paid),
            or(eq(invoices.status, 'processing'), and(exists(late), notExists(resolved)))));
      });
      if (!total!.count) return null;
      return { id: 'billing.checkout_debits', titleKey: 'billing/alerts:checkoutDebitsTitle', status: 'ready', kind: 'count', count: total!.count };
    },
  };
}
