// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated JSON text extraction for a gym-scoped audit lookup; the request ID is compared as a bound value.
import { sql } from 'drizzle-orm';
import { auditEvents } from '@plaingym/db';

export const switchRequestId = () => sql<string>`${auditEvents.after}->'request'->>'requestId'`;
