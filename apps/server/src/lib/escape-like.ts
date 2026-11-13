// SPDX-License-Identifier: AGPL-3.0-only
/** Escape literal text in a PostgreSQL LIKE/ILIKE pattern. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
