// SPDX-License-Identifier: AGPL-3.0-only
import { render } from '@react-email/render';
import { createElement } from 'react';
import type { Translator } from '@plaingym/shared';
import type { EmailTemplate } from '../../core/registry.js';
export async function renderDemoLogin(url: string, t: Translator) {
  const subject = t('demo/demo:loginSubject');
  return { subject, html: await render(createElement('a', { href: url }, t('demo/demo:loginLink'))), text: `${t('demo/demo:loginLink')}\n${url}` };
}
export const templates: readonly EmailTemplate[] = [];
