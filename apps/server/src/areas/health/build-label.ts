// SPDX-License-Identifier: AGPL-3.0-only
import { jsx } from 'hono/jsx';
import { createTranslator } from '@plaingym/shared';
import { sourceUrl } from '../../core/source-link.js';
import shell from '../../../../../locales/en/shell/shell.json' with { type: 'json' };
import { runningVersion } from './version.js';

const translate = createTranslator({ 'shell/shell': shell });

/** The label beside a "Source code" link: what runs here, and for a plain release, its notes on the source repository. */
export type BuildLabel = { text: string; label: string; href?: string };

export function buildLabel(version = runningVersion().version, source?: string): BuildLabel {
  const text = /^\d+\.\d+\.\d+$/.test(version) ? 'v' + version : version;
  const label = translate('shell/shell:version', { version });
  if (text === version) return { text, label };
  try {
    const url = new URL(source ?? sourceUrl());
    const repository = url.origin + '/' + url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return { text, label, href: `${repository}/releases/tag/${text}` };
  } catch { return { text, label }; }
}

/** The footer item for the running version, in the same muted style as its neighbours. Screen readers hear "Version 0.5.0". */
export function buildLabelItem(className = 'inline-flex min-h-11 items-center break-all', label = buildLabel()) {
  return label.href
    ? jsx('a', { href: label.href, rel: 'noreferrer', class: className + ' underline', 'aria-label': label.label }, label.text)
    : jsx('span', { role: 'note', class: className, 'aria-label': label.label }, label.text);
}
