// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Demo lifecycle queries only project JSON fields from the declared gyms system table; no raw table names or execution.
import { sql } from 'drizzle-orm';
import { gyms } from '@plaingym/db';

/** Parameterized JSON projections for the bounded, install-level demo lifecycle. */
export const demoText = (field: string) => sql<string>`${gyms.settings}->'demo'->>${field}`;
