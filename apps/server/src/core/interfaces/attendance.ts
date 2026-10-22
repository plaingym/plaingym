// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant, ListResponse, Pagination } from '@plaingym/shared/contracts';
import { paginationSchema } from '@plaingym/shared/contracts';
import { instant, notFound, scopedKey } from './common.js';
import type { MemberHouseholdContext, PortalIdentity } from './member-household.js';

export interface AttendanceEntry {
  readonly id: Id;
  readonly memberId: Id;
  readonly sessionId: Id | null;
  readonly programId: Id | null;
  readonly occurredAt: IsoInstant;
  readonly source: 'kiosk' | 'coach' | 'import';
}
export interface AttendanceFilter {
  readonly memberId?: Id;
  readonly programId?: Id;
  /** Class tag, not a member tag; imported attendance without a session has none. */
  readonly tagId?: Id;
  /** Inclusive lower bound, exclusive upper bound. */
  readonly since?: IsoInstant;
  readonly until?: IsoInstant;
}
/** Household implementations use forHousehold; gym scope is for authorized staff/jobs/kiosk. */
export type AttendanceScope = { readonly kind: 'gym'; readonly gymId: Id }
  | { readonly kind: 'household'; readonly identity: PortalIdentity };
export interface AttendanceQueries {
  countSince(scope: AttendanceScope, filter: AttendanceFilter & { memberId: Id; since: IsoInstant }): Promise<number>;
  /** Newest first, then ID ascending; each attendance counts once across program joins. */
  history(scope: AttendanceScope, filter: AttendanceFilter, page: Pagination): Promise<ListResponse<AttendanceEntry>>;
}
export interface AttendanceFixture {
  readonly gymId: Id;
  readonly entry: AttendanceEntry;
  /** Materialized session program/tag links, not template links. */
  readonly sessionProgramIds: readonly Id[];
  readonly sessionTagIds: readonly Id[];
}
export class FakeAttendanceQueries implements AttendanceQueries {
  readonly #entries: readonly AttendanceFixture[];
  constructor(entries: readonly AttendanceFixture[] = [], readonly households?: MemberHouseholdContext) {
    this.#entries = structuredClone(entries);
  }
  async #matching(scope: AttendanceScope, filter: AttendanceFilter): Promise<AttendanceEntry[]> {
    const context = scope.kind === 'household'
      ? await (this.households ?? notFound()).resolve(scope.identity) : undefined;
    const gymId = scope.kind === 'gym' ? scope.gymId : scope.identity.gymId;
    if (context && filter.memberId && !context.visibleMemberIds.includes(filter.memberId)) notFound();
    const since = filter.since === undefined ? -Infinity : instant(filter.since);
    const until = filter.until === undefined ? Infinity : instant(filter.until);
    if (until < since) throw new Error('Attendance range ends before it starts');
    const seen = new Set<string>();
    return this.#entries.filter(({ gymId: owner, entry, sessionProgramIds, sessionTagIds }) => {
      scopedKey(gymId, entry.id);
      const matches = owner === gymId && (!context || context.visibleMemberIds.includes(entry.memberId)) && (!filter.memberId || filter.memberId === entry.memberId)
        && (!filter.programId || filter.programId === entry.programId
          || (entry.sessionId !== null && sessionProgramIds.includes(filter.programId)))
        && (!filter.tagId || (entry.sessionId !== null && sessionTagIds.includes(filter.tagId)))
        && instant(entry.occurredAt) >= since && instant(entry.occurredAt) < until;
      if (!matches || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }).map(({ entry }) => entry).sort((a, b) => instant(b.occurredAt) - instant(a.occurredAt) || a.id.localeCompare(b.id));
  }
  async countSince(scope: AttendanceScope, filter: AttendanceFilter & { memberId: Id; since: IsoInstant }): Promise<number> {
    return (await this.#matching(scope, filter)).length;
  }
  async history(scope: AttendanceScope, filter: AttendanceFilter, page: Pagination): Promise<ListResponse<AttendanceEntry>> {
    const { limit, offset } = paginationSchema.parse(page);
    const matches = await this.#matching(scope, filter);
    return structuredClone({ data: matches.slice(offset, offset + limit), pagination: { limit, offset, total: matches.length } });
  }
}
