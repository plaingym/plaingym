// SPDX-License-Identifier: AGPL-3.0-only
import { createElement, type ReactNode } from 'react';
import { render, toPlainText } from '@react-email/render';
import type { Translator, TranslationValues } from '@plaingym/shared';
import type { RenderedEmail } from '../../core/registry.js';
import { EmailFooter, EmailHeader } from './components.js';

export interface EmailLayoutProps {
  readonly gymName: string;
  readonly t: Translator;
  /** Keys live in the calling feature's locale namespace. */
  readonly footerKey: string;
  readonly footerValues?: TranslationValues;
  readonly previewKey?: string;
  readonly previewValues?: TranslationValues;
  readonly language?: string;
  readonly children?: ReactNode;
}

export function EmailLayout(props: EmailLayoutProps) {
  const content = createElement('td', { style: { padding: '24px' } },
    createElement(EmailHeader, { gymName: props.gymName }),
    props.children,
    createElement(EmailFooter, { t: props.t, messageKey: props.footerKey,
      ...(props.footerValues ? { values: props.footerValues } : {}) }));
  const container = createElement('table', {
    role: 'presentation', width: '100%', cellPadding: 0, cellSpacing: 0,
    style: { maxWidth: '600px', backgroundColor: '#ffffff' },
  }, createElement('tbody', null, createElement('tr', null, content)));
  const centered = createElement('table', { role: 'presentation', width: '100%', cellPadding: 0, cellSpacing: 0 },
    createElement('tbody', null, createElement('tr', null, createElement('td', { align: 'center' }, container))));
  const preview = props.previewKey ? createElement('div', { 'data-skip-in-text': true,
    style: { display: 'none', maxHeight: 0, overflow: 'hidden' } }, props.t(props.previewKey, props.previewValues)) : null;
  return createElement('html', { lang: props.language ?? 'en' },
    createElement('head', null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' })),
    createElement('body', { style: { backgroundColor: '#f3f4f6', fontFamily: 'Arial, sans-serif', margin: 0 } },
      preview, centered));
}

/** Render once so both alternatives describe exactly the same translated content. */
export async function renderEmail(props: EmailLayoutProps & {
  readonly subjectKey: string;
  readonly subjectValues?: TranslationValues;
}): Promise<RenderedEmail> {
  const subject = props.t(props.subjectKey, props.subjectValues);
  if (!subject.trim() || /[\r\n\0]/.test(subject)) throw new Error('Invalid email subject');
  const html = await render(createElement(EmailLayout, props));
  const text = toPlainText(html, { selectors: [
    { selector: 'h1', options: { uppercase: false } },
  ] });
  return { subject, html, text };
}
