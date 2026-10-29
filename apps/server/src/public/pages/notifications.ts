// SPDX-License-Identifier: AGPL-3.0-only
import { jsx } from 'hono/jsx';
import { createTranslator, type Translator } from '@plaingym/shared';
import type { Email } from '../../infra/email/index.js';
import type { PublicPagesOptions } from './service.js';
import messages from '../../../../../locales/en/public/pages.json' with { type: 'json' };

/** Runtime prepare must return staff addresses only, never the visitor's address.
 * Only that wiring makes these notices exempt from the member-email switch.
 * Any visitor confirmation is member-facing mail and must apply that switch. */
export function createPublicStaffNotifier(prepare: (gymId: string) => Promise<{ email: Email; recipients: readonly string[]; gymName: string }>,
  t: Translator = createTranslator({ 'public/pages': messages })): PublicPagesOptions['notifyStaff'] {
  return async (gymId, intake) => {
    const { email, recipients, gymName } = await prepare(gymId);
    const subject = t('public/pages:staffSubject', { gym: gymName, kind: t('public/pages:' + intake.kind) });
    const text = t('public/pages:staffBody', { name: intake.member.firstName + ' ' + intake.member.lastName,
      contact: intake.contact.name, email: intake.contact.email, phone: intake.contact.phone ?? '' });
    const html = await jsx('p', { style: 'white-space:pre-wrap' }, text).toString();
    for (const to of new Set(recipients)) await email.sendEmail({ to, subject, text, html });
  };
}
