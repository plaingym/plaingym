// SPDX-License-Identifier: AGPL-3.0-only
import type { GoLiveChecklistItem } from '@plaingym/shared/contracts';

/** Recognizes the server's mode-change notice by its explicit contract flag. */
export function hasRestoreModeNote(item: Pick<GoLiveChecklistItem, 'id' | 'modeChanged'> | undefined): boolean {
  return item?.id === 'reconciliation_complete' && item.modeChanged === true;
}
