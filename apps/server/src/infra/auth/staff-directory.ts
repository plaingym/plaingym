// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import { authUser, householdUsers, staffProfiles, staffRoles, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import type { StaffAccountQuery } from '@plaingym/shared/contracts';
import { escapeLike } from '../../lib/escape-like.js';

/** Authentication identities are read only after matching a gym-owned account link.
 * In multi mode the install-wide identity name may come from another gym, so use a local profile or email. */
export function createStaffDirectory(database = systemDatabase, tenancy: 'single' | 'multi' = process.env.TENANCY === 'multi' ? 'multi' : 'single') {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  async function read(gymId: string, query: StaffAccountQuery, ids?: string[]) {
    return forGym(gymId, async (tx) => {
      const roleIds = tx.select({ id: staffRoles.userId }).from(staffRoles);
      const linked = query.staffOnly === 'true' ? inArray(authUser.id, roleIds) : or(inArray(authUser.id, roleIds),
        inArray(authUser.id, tx.select({ id: householdUsers.userId }).from(householdUsers)),
        inArray(authUser.id, tx.select({ id: staffProfiles.userId }).from(staffProfiles)));
      const where = and(linked, query.userId ? eq(authUser.id, query.userId) : undefined, ids ? inArray(authUser.id, ids) : undefined,
        ...(query.search?.split(/\s+/).filter(Boolean) ?? []).map((word) => {
          const pattern = '%' + escapeLike(word) + '%';
          return or(ilike(authUser.email, pattern), tenancy === 'single' ? ilike(authUser.name, pattern) : undefined,
            inArray(authUser.id, tx.select({ id: staffProfiles.userId }).from(staffProfiles).where(ilike(staffProfiles.displayName, pattern))));
        }));
      const total = await tx.$count(authUser, where);
      const rows = await tx.select({ id: authUser.id, email: authUser.email, name: authUser.name, profileName: staffProfiles.displayName })
        .from(authUser).leftJoin(staffProfiles, eq(staffProfiles.userId, authUser.id)).where(where)
        .orderBy(asc(authUser.email), asc(authUser.id)).limit(query.limit).offset(query.offset);
      return { data: rows.map(row => ({ id: row.id, email: row.email,
        displayName: row.profileName?.trim() || (tenancy === 'single' ? row.name.trim() : '') || row.email })),
      pagination: { limit: query.limit, offset: query.offset, total } };
    });
  }
  return { list: (gymId: string, query: StaffAccountQuery) => read(gymId, query),
    names: async (gymId: string, ids: string[]) => ids.length ? (await read(gymId, { limit: ids.length, offset: 0 }, ids)).data : [] };
}
