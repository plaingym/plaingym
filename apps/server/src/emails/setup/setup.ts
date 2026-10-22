// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import type { EmailMessage } from '../../infra/email/index.js';
import type { EmailTemplate } from '../../core/registry.js';
export const templates: readonly EmailTemplate[] = [];
const t = createTranslator(locales.en ?? {});
export function setupTestMessage(to: string): EmailMessage {
  const text = t('setup/setup:testBody');
  return { to, subject: t('setup/setup:testSubject'), text, html: `<p>${text}</p>` };
}
