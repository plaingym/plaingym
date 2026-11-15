// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../lib/i18n.js';

/** A successful restore check covers only the Stripe mode it actually read. */
export function RestoreModeNote({ checkedMode, savedMode }: { checkedMode: 'test' | 'live' | null | undefined; savedMode: 'test' | 'live' | null | undefined }) {
  if (!checkedMode || !savedMode || checkedMode === savedMode) return null;
  return <p className="break-words text-sm" role="note">{t('settings/go-live:reconcileModeChanged', {
    checkedMode: t('settings/integrations:payments.mode_' + checkedMode),
    savedMode: t('settings/integrations:payments.mode_' + savedMode),
  })}</p>;
}
