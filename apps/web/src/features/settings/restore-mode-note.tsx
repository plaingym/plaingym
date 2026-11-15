// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../lib/i18n.js';

/** Recognizes the server's mode sentence without inferring a saved mode from different credentials. */
export function hasRestoreModeNote(message: string) {
  return (['test', 'live'] as const).some(checkedMode => message.includes(t('settings/go-live:reconcileModeChanged', {
    checkedMode: t('settings/integrations:payments.mode_' + checkedMode),
    savedMode: t('settings/integrations:payments.mode_' + (checkedMode === 'test' ? 'live' : 'test')),
  })));
}
