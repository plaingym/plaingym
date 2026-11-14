// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator, type LocaleCatalog } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
export function createShellTranslator(catalog: LocaleCatalog = locales.en ?? {}) {
  return createTranslator({ ...catalog, 'shell/shell': { ...locales.en?.['shell/shell'], ...catalog['shell/shell'] } });
}
export const t = createShellTranslator();
