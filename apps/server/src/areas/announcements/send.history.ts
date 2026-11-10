// SPDX-License-Identifier: AGPL-3.0-only
import { count, desc, eq, inArray } from 'drizzle-orm';
import { announcementRecipients, announcements, forGym, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { announcementSchema, paginationSchema, type PaginationInput } from '@plaingym/shared/contracts';

export function createAnnouncementHistory(scope: typeof forGym = forGym) {
  async function present(tx: Transaction, rows: (typeof announcements.$inferSelect)[]) {
    const totals = rows.length ? await tx.select({ id: announcementRecipients.announcementId, state: announcementRecipients.state, count: count() })
      .from(announcementRecipients).where(inArray(announcementRecipients.announcementId, rows.map(row => row.id)))
      .groupBy(announcementRecipients.announcementId, announcementRecipients.state) : [];
    return rows.map(row => {
      const tally = (state: string) => totals.find(total => total.id === row.id && total.state === state)?.count ?? 0;
      return announcementSchema.parse({ id: row.id, createdBy: row.createdBy, subject: row.subject, body: row.body,
        audience: row.audience, recipientCount: row.recipientCount, status: row.status,
        createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
        sent: tally('sent'), failed: tally('failed'), skipped: tally('skipped') });
    });
  }
  return {
    async get(gymId: string, announcementId: string) {
      return scope(gymId, async tx => {
        const rows = await tx.select().from(announcements).where(eq(announcements.id, announcementId));
        if (!rows.length) throw new AppError('not_found', 'Announcement not found');
        return (await present(tx, rows))[0]!;
      });
    },
    async list(gymId: string, input: PaginationInput = {}) {
      const query = paginationSchema.parse(input);
      return scope(gymId, async tx => {
        const rows = await tx.select().from(announcements).orderBy(desc(announcements.createdAt), desc(announcements.id))
          .limit(query.limit).offset(query.offset);
        return { data: await present(tx, rows), pagination: { ...query, total: await tx.$count(announcements) } };
      });
    },
  };
}
