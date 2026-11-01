// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the check-in service learned of a PIN guess: `skipped` when no household or too many matched the name, so no
 * PIN was compared; `compared` for a wrong PIN; `verified` when it matched exactly one household.
 */
export type KioskPinCheck = 'skipped' | 'compared' | 'verified';
