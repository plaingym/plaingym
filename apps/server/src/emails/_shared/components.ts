// SPDX-License-Identifier: AGPL-3.0-only
import { createElement, type ReactNode } from 'react';
import type { Translator, TranslationValues } from '@plaingym/shared';

export interface TranslatedText {
  readonly t: Translator;
  readonly messageKey: string;
  readonly values?: TranslationValues;
}

export function EmailHeader({ gymName }: { readonly gymName: string }) {
  return createElement('p', { style: { fontSize: '20px', fontWeight: 700, color: '#111827' } }, gymName);
}

export function EmailFooter(props: TranslatedText) {
  return createElement('div', null,
    createElement('hr', { style: { border: 0, borderTop: '1px solid #e5e7eb', margin: '24px 0' } }),
    createElement('p', { style: { color: '#4b5563', fontSize: '12px', lineHeight: '18px' } },
      props.t(props.messageKey, props.values)));
}

export function EmailHeading(props: TranslatedText) {
  return createElement('h1', { style: { fontSize: '24px', lineHeight: '32px', color: '#111827' } },
    props.t(props.messageKey, props.values));
}

export function EmailText(props: TranslatedText) {
  return createElement('p', { style: { fontSize: '16px', lineHeight: '24px', color: '#1f2937' } },
    props.t(props.messageKey, props.values));
}

export function EmailButton(props: TranslatedText & { readonly href: string }) {
  const url = new URL(props.href);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Email button requires an HTTP(S) URL');
  return createElement('table', { role: 'presentation', cellPadding: 0, cellSpacing: 0 },
    createElement('tbody', null, createElement('tr', null,
      createElement('td', { style: { backgroundColor: '#111827', borderRadius: '6px', padding: '12px 20px' } },
        createElement('a', { href: url.href,
          style: { color: '#ffffff', fontSize: '16px', fontWeight: 600, textDecoration: 'none', display: 'inline-block' } },
        props.t(props.messageKey, props.values))))));
}

export type EmailContent = ReactNode;
