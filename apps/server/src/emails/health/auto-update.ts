// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate } from '../../core/registry.js';
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import messages from '../../../../../locales/en/health/auto-update.json' with { type: 'json' };
import { renderEmail } from '../_shared/layout.js';

export function renderAutoUpdateNotice(input: { gymName: string; message: string; time: string; timezone: string }) {
  const t = createTranslator({ 'health/auto-update': messages });
  return renderEmail({ gymName: input.gymName, t, subjectKey: 'health/auto-update:email.subject',
    footerKey: 'health/auto-update:email.footer', footerValues: { gymName: input.gymName },
    children: [createElement('p', { key: 'result' }, input.message),
      createElement('p', { key: 'time' }, t('health/auto-update:email.time', { time: input.time, timezone: input.timezone }))] });
}

export const templates: readonly EmailTemplate[] = [];
