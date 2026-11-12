// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { members } from '@plaingym/db';
export { normalizeAddress } from '@plaingym/db/schema/member-address';

/** The stored normalization allows an indexed equality under forced row-level security. */
export const addressEquals = (address: string) => eq(members.emailAddress, address);
