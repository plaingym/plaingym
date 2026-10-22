// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, lt } from 'drizzle-orm';
import { emailOutbox, forGym } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { outboxQuery } from '@plaingym/shared/contracts';

export function createOutboxQuery(scope: typeof forGym = forGym) {
  const present = (row: typeof emailOutbox.$inferSelect) => ({ id: row.id, recipient: row.recipient, subject: row.subject,
    html: row.html, text: row.text, sentAt: row.sentAt.toISOString() });
  return {
    async list(gymId: string, input: unknown) {
      const { before, limit } = outboxQuery.parse(input);
      const rows = await scope(gymId, (tx) => tx.select().from(emailOutbox)
        .where(and(eq(emailOutbox.gymId, gymId), ...(before ? [lt(emailOutbox.id, before)] : [])))
        .orderBy(desc(emailOutbox.id)).limit(limit + 1));
      return { data: rows.slice(0, limit).map(present), next: rows.length > limit ? rows[limit - 1]!.id : null };
    },
    async get(gymId: string, id: string) {
      const [row] = await scope(gymId, (tx) => tx.select().from(emailOutbox).where(and(eq(emailOutbox.gymId, gymId), eq(emailOutbox.id, id))));
      if (!row) throw new AppError('not_found', 'Message not found');
      return present(row);
    },
  };
}
