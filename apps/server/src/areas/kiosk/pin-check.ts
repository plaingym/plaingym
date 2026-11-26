// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the check-in service learned of a PIN guess: `skipped` when no household or too many matched the name, so no
 * PIN was compared; `compared` for a wrong PIN, or one shared by households the name can't tell apart; `verified` when
 * it picked one household (the only PIN match, or the only exact name among the matches).
 */
export type KioskPinCheck = 'skipped' | 'compared' | 'verified';
