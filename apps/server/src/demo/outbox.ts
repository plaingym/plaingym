// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, lt } from 'drizzle-orm';
import { emailOutbox, forGym } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { demoSignInLinkPath, outboxQuery } from '@plaingym/shared/contracts';

/** Every sign-in link in a sandbox is captured with this subject (`renderDemoLogin`, which the demo runtime sends with English). */
const signInSubject = createTranslator(locales.en ?? {})('demo/demo:loginSubject');

export function createOutboxQuery(scope: typeof forGym = forGym) {
  // Email bodies are read only for the preview.
  const metadata = { id: emailOutbox.id, recipient: emailOutbox.recipient, subject: emailOutbox.subject, text: emailOutbox.text, sentAt: emailOutbox.sentAt };
  const present = <Row extends { sentAt: Date }>(row: Row) => ({ ...row, sentAt: row.sentAt.toISOString() });
  const message = (gymId: string, id: string) => and(eq(emailOutbox.gymId, gymId), eq(emailOutbox.id, id));
  const found = <Row>([row]: Row[]) => {
    if (!row) throw new AppError('not_found', 'Message not found');
    return row;
  };
  return {
    async list(gymId: string, input: unknown) {
      const { before, limit } = outboxQuery.parse(input);
      const rows = await scope(gymId, (tx) => tx.select(metadata).from(emailOutbox)
        .where(and(eq(emailOutbox.gymId, gymId), ...(before ? [lt(emailOutbox.id, before)] : [])))
        .orderBy(desc(emailOutbox.id)).limit(limit + 1));
      return { data: rows.slice(0, limit).map(present), next: rows.length > limit ? rows[limit - 1]!.id : null };
    },
    async get(gymId: string, id: string) {
      return present(found(await scope(gymId, (tx) => tx.select(metadata).from(emailOutbox).where(message(gymId, id)))));
    },
    async preview(gymId: string, id: string) {
      return found(await scope(gymId, (tx) => tx.select({ html: emailOutbox.html }).from(emailOutbox).where(message(gymId, id)))).html;
    },
    /** The sign-in link from the latest sign-in message to one address in this gym's outbox, as a path on the gym's own origin.
     * Only sign-in messages qualify, never the rest of the outbox; anything else is 404. */
    async signInLink(gymId: string, email: string) {
      const [row] = await scope(gymId, (tx) => tx.select({ text: emailOutbox.text }).from(emailOutbox)
        .where(and(eq(emailOutbox.gymId, gymId), eq(emailOutbox.recipient, email.trim().toLowerCase()), eq(emailOutbox.subject, signInSubject)))
        // Latest by capture time; IDs made in the same millisecond needn't sort in capture order.
        .orderBy(desc(emailOutbox.sentAt), desc(emailOutbox.id)).limit(1));
      for (const match of row?.text.matchAll(/https?:\/\/\S+/g) ?? []) {
        const url = URL.canParse(match[0]) ? new URL(match[0]) : null;
        if (url?.pathname === demoSignInLinkPath && url.searchParams.has('token')) return { href: url.pathname + url.search };
      }
      throw new AppError('not_found', 'No sign-in link');
    },
  };
}
