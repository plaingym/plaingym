// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, asc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { attendances, auditEvents, memberRanks, members, programs, ranks, RevisionConflictError, uuidv7, type Transaction } from '@plaingym/db';
import { classKindSchema, idSchema, instantSchema, type ImportIssue, type ImportPlanRequest, type ImportTargetField } from '@plaingym/shared/contracts';
import { t } from '../pipeline.messages.js';
import { DuplicateIndex, duplicateKey, type CsvRow } from '../pipeline.csv.js';
import type { CsvMapper, MapperContext, PlannedRow } from './registry.js';

type Reader = Pick<Transaction, 'select'>;
type Values = PlannedRow['values'];
const fields = ['externalId', 'firstName', 'lastName', 'email', 'dateOfBirth', 'program', 'rank', 'subRank', 'promotedAt', 'occurredAt', 'classTags'] as const;
type Field = (typeof fields)[number] & ImportTargetField;
interface Identity { email: string; firstName: string; lastName: string; dateOfBirth: string }
interface Parsed { kind: 'promotion' | 'attendance'; identity: Identity; at: Date; program: string; rank: string; subRank: string; openMat: boolean; externalId: string }
interface Source { row: CsvRow; values: Values; issues: ImportIssue[]; parsed?: Parsed }
interface Rung { id: string | null; rowNumber: number | null; position: number; subRank: number; at: number }

/** Matches names, emails and pick lists the same way `duplicateKey` normalizes identities. */
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const compact = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]/gu, '');
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const committedSchema = z.discriminatedUnion('record', [
  z.object({ record: z.literal('promotion'), memberId: idSchema, programId: idSchema, rankId: idSchema, rankSystemId: idSchema,
    subRank: z.int().nonnegative(), promotedAt: instantSchema, memberRevision: z.int().positive(), programRevision: z.int().positive(), rankRevision: z.int().positive() }),
  z.object({ record: z.literal('attendance'), memberId: idSchema, programId: idSchema.nullable(), occurredAt: instantSchema,
    kind: classKindSchema, sourceKey: z.string().min(1), memberRevision: z.int().positive(), programRevision: z.int().positive().nullable() }),
]);
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * ISO dates and date-times. TODO(CCR): the mapper context has no gym timezone, so values
 * without an offset are read as UTC; a date alone is the start of that UTC day.
 */
export function parseInstant(value: string): Date | null {
  const match = INSTANT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', offset] = match;
  const parts = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  const [year, month, day, hour, minute, second] = parts;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  let shift = 0;
  if (offset && offset.toUpperCase() !== 'Z') {
    const digits = offset.replace(':', ''), hours = Number(digits.slice(1, 3)), minutes = Number(digits.slice(3));
    if (hours > 14 || minutes > 59) return null;
    shift = (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3))) - shift * 60_000);
  return year < 1900 ? null : date;
}
function readDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return parseInstant(value)?.toISOString().slice(0, 10) === value ? value : null;
}

function parseRow(row: CsvRow, plan: ImportPlanRequest): Source {
  const columns = new Map(plan.mapping.map((item) => [item.targetField, item.sourceColumn]));
  const read = (field: Field) => { const column = columns.get(field); return column === undefined ? '' : (row.values[column] ?? '').trim(); };
  const issues: ImportIssue[] = [], values: Values = {};
  const issue = (field: Field | null, code: ImportIssue['code'], key: string, params: Record<string, string | number> = {}) =>
    issues.push({ rowNumber: row.rowNumber, column: field === null ? null : columns.get(field) ?? null, code, message: t('imports/mat:' + key, params) });
  for (const field of fields) if (columns.has(field)) values[field] = read(field);
  const identity: Identity = { email: normalize(read('email')), firstName: normalize(read('firstName')),
    lastName: normalize(read('lastName')), dateOfBirth: read('dateOfBirth') };
  if (!identity.email && !(identity.firstName && identity.lastName))
    issue(identity.firstName ? 'lastName' : identity.lastName ? 'firstName' : 'email', 'missing_required', 'missingMember');
  if (identity.dateOfBirth && !readDate(identity.dateOfBirth)) issue('dateOfBirth', 'invalid_value', 'invalidBirthDate');
  const rank = read('rank'), promotedAt = read('promotedAt'), occurredAt = read('occurredAt'), program = read('program');
  const promotion = Boolean(rank || promotedAt || read('subRank'));
  if (promotion && occurredAt) { issue(null, 'invalid_value', 'bothKinds'); return { row, values, issues }; }
  if (!promotion && !occurredAt) { issue(null, 'missing_required', 'recordKind'); return { row, values, issues }; }
  const field = promotion ? 'promotedAt' : 'occurredAt', text = promotion ? promotedAt : occurredAt, at = parseInstant(text);
  if (!text) issue(field, 'missing_required', 'missingDate');
  else if (!at) issue(field, 'invalid_value', 'invalidDate');
  if (promotion && !rank) issue('rank', 'missing_required', 'missingRank');
  if (promotion && !program) issue('program', 'missing_required', 'missingProgram');
  const openMat = !promotion && (compact(program) === 'openmat'
    || read('classTags').split(/[,;|]/).some((tag) => compact(tag) === 'openmat'));
  if (at) values[field] = at.toISOString();
  return { row, values, issues, ...(issues.length || !at ? {} : {
    parsed: { kind: promotion ? 'promotion' : 'attendance', identity, at, program, rank, subRank: read('subRank'), openMat, externalId: read('externalId') },
  }) };
}
/** Source IDs distinguish visits at the same time; otherwise use the visit's complete identity. */
function fileKey(parsed: Parsed): string | null {
  const { email, firstName, lastName, dateOfBirth } = parsed.identity;
  return JSON.stringify([duplicateKey([parsed.kind, email, firstName, lastName, dateOfBirth, parsed.at.toISOString(),
    ...(parsed.kind === 'promotion' ? [parsed.program, parsed.rank, parsed.subRank] : [parsed.program, String(parsed.openMat)])]),
    parsed.kind === 'attendance' ? parsed.externalId : '']);
}
function attendanceKey(parsed: Parsed, memberId: string, programId: string | null): string {
  // externalId may be a member ID in an auto-matched export. Always include the
  // visit identity too, so one member's source ID never collapses their whole history.
  const identity = [memberId, parsed.at.toISOString(), programId, parsed.openMat, parsed.externalId];
  return 'mat:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
// Scoped to one immutable run source (and mapping), never shared across files or gyms.
interface FileIndex { duplicates: DuplicateIndex; promotions: Source[] }
const fileIndexes = new WeakMap<readonly CsvRow[], Map<string, FileIndex>>();
function fileIndex(rows: readonly CsvRow[], plan: ImportPlanRequest): FileIndex {
  const byMapping = fileIndexes.get(rows) ?? new Map<string, FileIndex>(), mapping = JSON.stringify(plan.mapping);
  fileIndexes.set(rows, byMapping);
  let index = byMapping.get(mapping);
  if (!index) {
    index = { duplicates: new DuplicateIndex(), promotions: [] };
    for (const row of rows) {
      const source = parseRow(row, plan);
      if (source.parsed) index.duplicates.add(fileKey(source.parsed), String(row.rowNumber));
      if (source.parsed?.kind === 'promotion') index.promotions.push(source);
    }
    byMapping.set(mapping, index);
  }
  return index;
}

async function candidates(tx: Reader, gymId: string, identities: readonly Identity[]) {
  const emails = [...new Set(identities.flatMap((item) => item.email ? [item.email] : []))];
  const names = [...new Map(identities.filter((item) => item.firstName && item.lastName)
    .map((item) => [JSON.stringify([item.firstName, item.lastName]), item])).values()];
  if (!emails.length && !names.length) return [];
  return tx.select({ id: members.id, email: members.email, firstName: members.firstName, lastName: members.lastName,
    dateOfBirth: members.dateOfBirth, revision: members.revision }).from(members).where(and(eq(members.gymId, gymId), isNull(members.anonymizedAt), or(
    ...emails.map((email) => ilike(members.email, escapeLike(email))),
    ...names.map((item) => and(ilike(members.firstName, escapeLike(item.firstName)), ilike(members.lastName, escapeLike(item.lastName)))),
  ))).orderBy(asc(members.id));
}
const order = (a: Pick<Rung, 'position' | 'subRank'>, b: Pick<Rung, 'position' | 'subRank'>) => a.position - b.position || a.subRank - b.subRank;
function matchesIdentity(person: Awaited<ReturnType<typeof candidates>>[number], identity: Identity): boolean {
  return (!identity.email || normalize(person.email ?? '') === identity.email)
    && (!identity.firstName || normalize(person.firstName) === identity.firstName)
    && (!identity.lastName || normalize(person.lastName) === identity.lastName)
    && (!identity.dateOfBirth || person.dateOfBirth === identity.dateOfBirth);
}
/** A promotion must rank above every earlier one and below every later one in the same program. */
function contradicts(entry: Pick<Rung, 'position' | 'subRank' | 'at'>, others: readonly Pick<Rung, 'position' | 'subRank' | 'at'>[]): boolean {
  return others.some((other) => other !== entry && (other.at < entry.at ? order(other, entry) >= 0
    : other.at > entry.at ? order(other, entry) <= 0 : order(other, entry) === 0));
}

async function analyze(tx: Reader, rows: readonly CsvRow[], plan: ImportPlanRequest, context: MapperContext): Promise<PlannedRow[]> {
  const { gymId } = context, now = context.clock.now().getTime();
  const { duplicates: index, promotions: filePromotions } = fileIndex(context.sourceRows, plan);
  const sources = rows.map((row) => parseRow(row, plan));
  const rowNumbers = new Set(rows.map((row) => row.rowNumber));
  const chunkIdentities = sources.flatMap((source) => source.parsed?.kind === 'promotion' ? [source.parsed.identity] : []);
  if (chunkIdentities.length) {
    const chunkPeople = await candidates(tx, gymId, chunkIdentities);
    // Validate each affected member's complete source history, even in a dry run
    // where earlier chunks have written nothing. Resolve aliases against the gym
    // again below so a shared email cannot silently identify the wrong member.
    sources.push(...filePromotions.filter((source) => !rowNumbers.has(source.row.rowNumber)
      && chunkPeople.some((person) => matchesIdentity(person, source.parsed!.identity)))
      .map((source) => ({ ...source, values: { ...source.values }, issues: [...source.issues] })));
    sources.sort((a, b) => a.row.rowNumber - b.row.rowNumber);
  }
  const fail = (source: Source, field: Field | null, code: ImportIssue['code'], key: string, params: Record<string, string | number> = {}) => {
    const column = field === null ? null : plan.mapping.find((item) => item.targetField === field)?.sourceColumn ?? null;
    source.issues.push({ rowNumber: source.row.rowNumber, column, code, message: t('imports/mat:' + key, params) });
  };
  for (const source of sources) {
    if (!source.parsed) continue;
    const first = Math.min(...index.find(fileKey(source.parsed)).map(Number));
    if (first < source.row.rowNumber) fail(source, null, 'duplicate', 'duplicateRow', { row: first });
    if (source.parsed.at.getTime() > now) fail(source, source.parsed.kind === 'promotion' ? 'promotedAt' : 'occurredAt', 'invalid_value', 'futureDate');
  }
  const pending = () => sources.filter((source): source is Source & { parsed: Parsed } => !!source.parsed && !source.issues.length);
  const people = await candidates(tx, gymId, pending().map((source) => source.parsed.identity));
  const programRows = await tx.select({ id: programs.id, name: programs.name, rankSystemId: programs.rankSystemId, revision: programs.revision })
    .from(programs).where(eq(programs.gymId, gymId)).orderBy(asc(programs.id));
  const rankRows = await tx.select({ id: ranks.id, rankSystemId: ranks.rankSystemId, name: ranks.name, position: ranks.position, subRanks: ranks.subRanks, revision: ranks.revision })
    .from(ranks).where(eq(ranks.gymId, gymId)).orderBy(asc(ranks.id));
  const positions = new Map(rankRows.map((rank) => [rank.id, rank.position]));
  for (const source of pending()) {
    const { identity, program: programName, rank: rankName, subRank: subRankText, kind } = source.parsed;
    const matched = people.filter((person) => matchesIdentity(person, identity));
    const column: Field = identity.email ? 'email' : 'lastName';
    if (matched.length !== 1) { fail(source, column, 'unknown_reference', matched.length ? 'ambiguousMember' : 'unknownMember'); continue; }
    source.values.memberId = matched[0]!.id;
    source.values.memberRevision = matched[0]!.revision;
    const programMatches = programName ? programRows.filter((item) => normalize(item.name) === normalize(programName)) : [];
    if (programMatches.length > 1) { fail(source, 'program', 'unknown_reference', 'ambiguousProgram'); continue; }
    const program = programMatches[0];
    if (kind === 'attendance') {
      // An unknown "Open Mat" program only marks the visit's kind.
      if (programName && !program && compact(programName) !== 'openmat') { fail(source, 'program', 'unknown_reference', 'unknownProgram'); continue; }
      Object.assign(source.values, { record: 'attendance', programId: program?.id ?? null, programRevision: program?.revision ?? null,
        kind: source.parsed.openMat ? 'open_mat' : 'class', sourceKey: attendanceKey(source.parsed, matched[0]!.id, program?.id ?? null) });
      continue;
    }
    if (!program) { fail(source, 'program', 'unknown_reference', 'unknownProgram'); continue; }
    if (!program.rankSystemId) { fail(source, 'program', 'unknown_reference', 'noRankSystem'); continue; }
    const rankMatches = rankRows.filter((item) => item.rankSystemId === program.rankSystemId && normalize(item.name) === normalize(rankName));
    if (rankMatches.length !== 1) { fail(source, 'rank', 'unknown_reference', rankMatches.length ? 'ambiguousRank' : 'unknownRank'); continue; }
    const rank = rankMatches[0]!, subRanks = rank.subRanks as { id: string; name: string }[];
    // A number counts sub-ranks reached (0 = none); a name or ID picks that sub-rank.
    const subRank = !subRankText ? 0 : /^\d+$/.test(subRankText) ? Number(subRankText)
      : subRanks.findIndex((item) => normalize(item.name) === normalize(subRankText) || normalize(item.id) === normalize(subRankText)) + 1;
    if ((subRankText && !/^\d+$/.test(subRankText) && subRank === 0) || subRank > subRanks.length) {
      fail(source, 'subRank', 'invalid_value', 'invalidSubRank', { max: subRanks.length }); continue;
    }
    Object.assign(source.values, { record: 'promotion', programId: program.id, rankId: rank.id, rankSystemId: program.rankSystemId, subRank,
      programRevision: program.revision, rankRevision: rank.revision });
  }
  let ready = pending().filter((source) => source.values.record !== undefined);
  const resolved = new Map<string, number>();
  for (const source of ready) {
    const key = source.values.record === 'attendance' ? String(source.values.sourceKey)
      : JSON.stringify([source.values.memberId, source.values.programId, source.values.rankId, source.values.subRank, source.values.promotedAt]);
    const first = resolved.get(key);
    if (first !== undefined) fail(source, null, 'duplicate', 'duplicateRow', { row: first });
    else resolved.set(key, source.row.rowNumber);
  }
  ready = ready.filter((source) => !source.issues.length);
  const duplicates = new Map<number, string>();
  const keys = ready.flatMap((source) => source.values.record === 'attendance' ? [String(source.values.sourceKey)] : []);
  const existingVisits = keys.length ? await tx.select({ id: attendances.id, sourceKey: attendances.sourceKey }).from(attendances)
    .where(and(eq(attendances.gymId, gymId), inArray(attendances.sourceKey, keys))) : [];
  const visitIds = new Map(existingVisits.map((row) => [row.sourceKey, row.id]));
  const promotions = ready.filter((source) => source.values.record === 'promotion');
  const history = promotions.length ? await tx.select({ id: memberRanks.id, memberId: memberRanks.memberId, programId: memberRanks.programId,
    rankId: memberRanks.rankId, subRank: memberRanks.subRank, promotedAt: memberRanks.promotedAt }).from(memberRanks)
    .where(and(eq(memberRanks.gymId, gymId), inArray(memberRanks.memberId, [...new Set(promotions.map((source) => String(source.values.memberId)))]),
      inArray(memberRanks.programId, [...new Set(promotions.map((source) => String(source.values.programId)))]))) : [];
  const ladders = new Map<string, Rung[]>(), ladder = (memberId: unknown, programId: unknown) => {
    const key = JSON.stringify([memberId, programId]), list = ladders.get(key) ?? []; ladders.set(key, list); return list;
  };
  for (const row of history) ladder(row.memberId, row.programId).push({ id: row.id, rowNumber: null,
    position: positions.get(row.rankId) ?? 0, subRank: row.subRank, at: row.promotedAt.getTime() });
  for (const source of ready) {
    if (source.values.record === 'attendance') {
      const id = visitIds.get(String(source.values.sourceKey));
      if (id) duplicates.set(source.row.rowNumber, id);
      continue;
    }
    const rankId = String(source.values.rankId), at = source.parsed.at.getTime(), list = ladder(source.values.memberId, source.values.programId);
    const same = history.find((row) => row.memberId === source.values.memberId && row.programId === source.values.programId
      && row.rankId === rankId && row.subRank === source.values.subRank && row.promotedAt.getTime() === at);
    if (same) duplicates.set(source.row.rowNumber, same.id);
    else list.push({ id: null, rowNumber: source.row.rowNumber, position: positions.get(rankId)!, subRank: Number(source.values.subRank), at });
  }
  for (const source of promotions) {
    const list = ladder(source.values.memberId, source.values.programId);
    const entry = list.find((item) => item.rowNumber === source.row.rowNumber);
    if (entry && contradicts(entry, list)) fail(source, 'promotedAt', 'conflict', 'historyConflict');
  }
  const byRow = new Map(sources.map((source) => [source.row.rowNumber, source]));
  return rows.map((input) => {
    const { row, values, issues } = byRow.get(input.rowNumber)!;
    const duplicate = issues.length ? undefined : duplicates.get(row.rowNumber);
    // Imported history is immutable: an exact match has nothing to update, so the update policy skips it.
    if (duplicate && plan.duplicatePolicy === 'update') return { rowNumber: row.rowNumber, values, action: 'skip', duplicateIds: [], issues };
    return { rowNumber: row.rowNumber, values, action: issues.length ? 'error' : 'create', duplicateIds: duplicate ? [duplicate] : [], issues };
  });
}

async function commit(tx: Transaction, rows: readonly PlannedRow[], context: MapperContext): Promise<number> {
  if (rows.length > 100) throw new Error('Mat imports require chunks of at most 100 rows');
  const records = rows.filter((row) => row.action === 'create' && !row.issues.length).map((row) => committedSchema.parse(row.values));
  if (!records.length) return 0;
  const now = context.clock.now(), { gymId } = context;
  // Use the same member lock as the promotion service. Editable references must still
  // have the revisions analyzed by the mapper, and remain locked until this chunk commits.
  const memberIds = [...new Set(records.map((item) => item.memberId))].sort();
  const lockedMembers = await tx.select({ id: members.id, revision: members.revision, anonymizedAt: members.anonymizedAt })
    .from(members).where(and(eq(members.gymId, gymId), inArray(members.id, memberIds))).orderBy(asc(members.id)).for('update');
  const programIds = [...new Set(records.flatMap((item) => item.programId ? [item.programId] : []))].sort();
  const lockedPrograms = programIds.length ? await tx.select().from(programs)
    .where(and(eq(programs.gymId, gymId), inArray(programs.id, programIds))).orderBy(asc(programs.id)).for('share') : [];
  const promotions = records.flatMap((record) => record.record === 'promotion' ? [record] : []);
  const rankIds = [...new Set(promotions.map((item) => item.rankId))].sort();
  const lockedRanks = rankIds.length ? await tx.select().from(ranks)
    .where(and(eq(ranks.gymId, gymId), inArray(ranks.id, rankIds))).orderBy(asc(ranks.id)).for('share') : [];
  for (const record of records) {
    const member = lockedMembers.find((item) => item.id === record.memberId);
    const program = lockedPrograms.find((item) => item.id === record.programId);
    if (!member || member.anonymizedAt || member.revision !== record.memberRevision
      || (record.programId && (!program || program.revision !== record.programRevision))) throw new RevisionConflictError();
    if (record.record === 'promotion') {
      const rank = lockedRanks.find((item) => item.id === record.rankId);
      if (!rank || rank.revision !== record.rankRevision || rank.rankSystemId !== record.rankSystemId
        || program?.rankSystemId !== record.rankSystemId || record.subRank > (rank.subRanks as unknown[]).length) throw new RevisionConflictError();
    }
  }
  const actor = { gymId, actorKind: context.actor.kind, ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    occurredAt: now, createdAt: now } as const;
  const visits = records.flatMap((record) => record.record === 'attendance' ? [record] : []);
  const inserted = visits.length ? await tx.insert(attendances).values(visits.map((visit) => ({ id: uuidv7(now.getTime()), gymId,
    memberId: visit.memberId, programId: visit.programId, sessionId: null, occurredAt: new Date(visit.occurredAt), source: 'import',
    sourceKey: visit.sourceKey, kind: visit.kind, createdAt: now })))
    .onConflictDoNothing({ target: [attendances.gymId, attendances.sourceKey] }).returning() : [];
  let promoted: (typeof memberRanks.$inferSelect)[] = [];
  if (promotions.length) {
    const existing = await tx.select().from(memberRanks).where(and(eq(memberRanks.gymId, gymId), inArray(memberRanks.memberId, memberIds)));
    const seen = new Set(existing.map((row) => JSON.stringify([row.memberId, row.programId, row.rankId, row.subRank, row.promotedAt.toISOString()])));
    const fresh = promotions.filter((item) => {
      const key = JSON.stringify([item.memberId, item.programId, item.rankId, item.subRank, new Date(item.promotedAt).toISOString()]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const history = await tx.select({ promotion: memberRanks, position: ranks.position }).from(memberRanks)
      .innerJoin(ranks, and(eq(ranks.gymId, memberRanks.gymId), eq(ranks.id, memberRanks.rankId)))
      .where(and(eq(memberRanks.gymId, gymId), inArray(memberRanks.memberId, memberIds)));
    // Revalidate chronology under the lock, including rows inserted since analyze.
    const combined = [
      ...history.map(({ promotion, position }) => ({ memberId: promotion.memberId, programId: promotion.programId,
        position, subRank: promotion.subRank, at: promotion.promotedAt.getTime() })),
      ...fresh.map((item) => ({ memberId: item.memberId, programId: item.programId, position: lockedRanks.find((rank) => rank.id === item.rankId)!.position,
        subRank: item.subRank, at: new Date(item.promotedAt).getTime() })),
    ];
    for (const entry of combined.slice(history.length)) {
      if (contradicts(entry, combined.filter((other) => other.memberId === entry.memberId && other.programId === entry.programId)))
        throw new RevisionConflictError();
    }
    promoted = fresh.length ? await tx.insert(memberRanks).values(fresh.map((item) => ({ id: uuidv7(now.getTime()), gymId, createdAt: now,
      memberId: item.memberId, programId: item.programId, rankId: item.rankId, rankSystemId: item.rankSystemId, subRank: item.subRank,
      promotedAt: new Date(item.promotedAt), promotedBy: null, notes: null }))).returning() : [];
  }
  // IDs, times and kinds only: audit rows are append-only and must not copy names or emails.
  const events = [
    ...inserted.map((row) => ({ ...actor, action: 'attendance.recorded', targetType: 'attendance', targetId: row.id,
      after: { importId: context.runId, memberId: row.memberId, programId: row.programId, occurredAt: row.occurredAt.toISOString(),
        source: row.source, kind: row.kind } })),
    ...promoted.map((row) => ({ ...actor, action: 'promotion.created', targetType: 'promotion', targetId: row.id,
      after: { importId: context.runId, memberId: row.memberId, programId: row.programId, rankId: row.rankId,
        rankSystemId: row.rankSystemId, subRank: row.subRank, promotedAt: row.promotedAt.toISOString() } })),
  ];
  if (events.length) await tx.insert(auditEvents).values(events);
  return inserted.length + promoted.length;
}

/** Ranks, promotion dates and session-less attendance history (`areas/imports/mappers/mat.md`). */
export const matMapper: CsvMapper = { id: 'mat', available: true, analyze, commit };
