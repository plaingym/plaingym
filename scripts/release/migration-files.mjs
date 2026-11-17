// SPDX-License-Identifier: AGPL-3.0-only
export const migrations = 'packages/db/src/migrations';
export const journal = `${migrations}/meta/_journal.json`;

/** @param {string} base */
export function assertMigrationBase(base) {
  if (!base || /^0+$/.test(base)) throw new Error('Give the main merge base');
}
