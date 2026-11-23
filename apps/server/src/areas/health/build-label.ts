// SPDX-License-Identifier: AGPL-3.0-only
import { jsx } from 'hono/jsx';
import { createTranslator, type Translator } from '@plaingym/shared';
import { sourceUrl } from '../../core/source-link.js';
import { isRelease, releaseRepository } from '../../core/source-repository.js';
import shell from '../../../../../locales/en/shell/shell.json' with { type: 'json' };
import { runningVersion } from './version.js';

const english = createTranslator({ 'shell/shell': shell });

/** The label beside a "Source code" link: what runs here, and for a plain release, its notes on the source repository. */
export type BuildLabel = { text: string; label: string; prefix: string; href?: string };

export function buildLabel(version = runningVersion().version, source?: string, translate: Translator = english): BuildLabel {
  const release = isRelease(version);
  const text = release ? 'v' + version : version;
  const label = { text, label: translate('shell/shell:version', { version: text }), prefix: translate('shell/shell:versionPrefix') };
  if (!release) return label;
  try {
    const repository = releaseRepository(source ?? sourceUrl());
    return repository ? { ...label, href: `${repository}/releases/tag/${text}` } : label;
  } catch { return label; }
}

/** The footer item for the running version, in the same muted style as its neighbours. */
export function buildLabelItem(className = 'inline-flex min-h-11 items-center break-all', label = buildLabel(), options: { visibleName?: boolean } = {}) {
  const children = options.visibleName ? [label.label] : [jsx('span', { class: 'sr-only' }, label.prefix + ' '), label.text];
  return label.href
    ? jsx('a', { href: label.href, rel: 'noreferrer', class: className + ' min-w-11 justify-center underline' }, ...children)
    : jsx('span', { class: className }, ...children);
}
