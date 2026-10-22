// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator, type LocaleCatalog, type Messages } from '../packages/shared/src/i18n.js';

export function loadLocale(files: Readonly<Record<string, unknown>>, locale = 'en'): LocaleCatalog {
  const catalog: Record<string, Messages> = Object.create(null) as Record<string, Messages>;
  for (const [path, contents] of Object.entries(files)) {
    const normalized = path
      .replaceAll('\\', '/')
      .replace(/^.*?locales\//, '')
      .replace(/^\.\//, '');
    if (!normalized.startsWith(locale + '/') || !normalized.endsWith('.json')) continue;
    if (typeof contents !== 'object' || contents === null || Array.isArray(contents))
      throw new Error(`Invalid locale: ${path}`);
    const messages: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(contents)) {
      if (key === '$comment') continue;
      if (typeof value !== 'string') throw new Error(`Invalid translation: ${path}:${key}`);
      messages[key] = value;
    }
    const namespace = normalized.slice(locale.length + 1, -5);
    if (Object.hasOwn(catalog, namespace)) throw new Error(`Duplicate namespace: ${namespace}`);
    catalog[namespace] = messages;
  }
  return catalog;
}
export function translatorFor(files: Readonly<Record<string, unknown>>, locale = 'en') {
  return createTranslator(loadLocale(files, locale));
}
