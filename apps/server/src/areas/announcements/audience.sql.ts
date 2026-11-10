// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated normalized-address expression over gym-owned members only; no system-table access.
import { sql } from 'drizzle-orm';
import { members } from '@plaingym/db';

/** Isolated SQL expression: exact normalized address equality, including legacy surrounding spaces. */
export const addressEquals = (address: string) => sql`lower(btrim(${members.email})) = ${address}`;
