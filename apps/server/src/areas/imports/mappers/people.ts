// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { households, members, memberTags, memberTagLinks, paymentMethods, revisionGuard, assertRevised, uuidv7, writeAudit,
  type Transaction } from '@plaingym/db';
import type { ImportIssue, ImportPlanRequest, ImportPreviewRow } from '@plaingym/shared/contracts';
import { t } from '../pipeline.messages.js';
import type { CsvRow } from '../pipeline.csv.js';
import type { CsvMapper, MapperContext, PlannedRow } from './registry.js';
import { detectDateOrder, householdKey, knownKeys, lookupKeys, mapPerson, tagKey, type MemberStatus, type Person } from './people.parse.js';

/** Household values shared by every row of a family, taken from its first row that has each one. */
interface Family {
  key: string; people: Person[]; name: string; email: string | null; phone: string | null;
  billingDay: number | null; stripeCustomerId: string | null;
}
interface FileIndex { people: Map<number, Person>; families: Map<string, Family>; familyKeys: Map<number, string> }
type Reader = Pick<Transaction, 'select'>;
const message = (key: string, values?: Record<string, string | number>) => t('imports/people:' + key, values);
const search = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/**
 * The run's source rows are immutable and complete, so a run analyzes its whole file once.
 * The cache is keyed by that run's own row array (and mapping), never shared across runs or gyms.
 */
const fileIndexes = new WeakMap<readonly CsvRow[], Map<string, FileIndex>>();
function fileIndex(source: readonly CsvRow[], plan: ImportPlanRequest, today: string): FileIndex {
  const cacheKey = JSON.stringify([plan.mapping, today]);
  const cached = fileIndexes.get(source)?.get(cacheKey);
  if (cached) return cached;
  const birthColumn = plan.mapping.find((item) => item.targetField === 'dateOfBirth')?.sourceColumn;
  const dateOrder = detectDateOrder(birthColumn === undefined ? [] : source.map((row) => row.values[birthColumn] ?? ''));
  const people = new Map<number, Person>(), families = new Map<string, Family>(), firstSeen = new Map<string, number>();
  for (const row of source) {
    const person = mapPerson(row, plan.mapping, { dateOrder, today });
    people.set(row.rowNumber, person);
    // Within-file duplicates: the later row is reported; the first occurrence stays importable.
    const earlier = lookupKeys(person).map((key) => firstSeen.get(key)).find((rowNumber) => rowNumber !== undefined);
    if (earlier !== undefined) person.issues.push({ rowNumber: row.rowNumber, column: null, code: 'duplicate', message: message('duplicateInFile', { row: earlier }) });
    for (const key of knownKeys(person)) if (!firstSeen.has(key)) firstSeen.set(key, row.rowNumber);
  }
  // Explicit family references take precedence. A shared customer can also group people
  // whose export gives each member an ID but no separate household reference.
  const references = new Set([...people.values()].flatMap((person) => person.householdExternalId ? [person.householdExternalId] : []));
  const anchored = (person: Person) => person.householdExternalId !== null || person.externalId !== null && references.has(person.externalId);
  const customerFamilies = new Map<string, Set<string>>();
  for (const person of people.values()) if (person.stripeCustomerId && anchored(person)) {
    const keys = customerFamilies.get(person.stripeCustomerId) ?? new Set<string>();
    keys.add(householdKey(person)); customerFamilies.set(person.stripeCustomerId, keys);
  }
  const familyKeys = new Map<number, string>();
  for (const person of people.values()) {
    const customerKeys = person.stripeCustomerId ? customerFamilies.get(person.stripeCustomerId) : undefined;
    const key = anchored(person) || !person.stripeCustomerId ? householdKey(person)
      : customerKeys?.size === 1 ? [...customerKeys][0]! : JSON.stringify(['customer', person.stripeCustomerId]);
    familyKeys.set(person.rowNumber, key);
    const family = families.get(key);
    if (family) family.people.push(person);
    else families.set(key, { key, people: [person], name: '', email: null, phone: null, billingDay: null, stripeCustomerId: null });
  }
  const customers = new Map<string, string>(), methods = new Map<string, string>();
  for (const family of families.values()) {
    const first = <T>(read: (person: Person) => T | null) => family.people.map(read).find((value) => value !== null) ?? null;
    const head = family.people[0]!;
    family.name = first((person) => person.householdName)
      ?? ([head.firstName, head.lastName].filter(Boolean).join(' ') || message('unnamedHousehold'));
    family.email = first((person) => person.email); family.phone = first((person) => person.phone);
    family.billingDay = first((person) => person.billingDay); family.stripeCustomerId = first((person) => person.stripeCustomerId);
    for (const person of family.people) {
      const disagree = (field: 'householdName' | 'billingDay' | 'stripeCustomerId', own: unknown, shared: unknown) => {
        if (own !== null && own !== shared) person.issues.push({ rowNumber: person.rowNumber, column: plan.mapping.find((item) => item.targetField === field)?.sourceColumn ?? null,
          code: 'invalid_value', message: message('familyMismatch') });
      };
      disagree('householdName', person.householdName, family.name);
      disagree('billingDay', person.billingDay, family.billingDay);
      disagree('stripeCustomerId', person.stripeCustomerId, family.stripeCustomerId);
      // A Stripe customer or saved payment method belongs to one household.
      const claim = (owners: Map<string, string>, id: string | null, field: 'stripeCustomerId' | 'stripePaymentMethodId') => {
        if (id === null) return;
        const owner = owners.get(id);
        if (owner === undefined) owners.set(id, family.key);
        else if (owner !== family.key) person.issues.push({ rowNumber: person.rowNumber,
          column: plan.mapping.find((item) => item.targetField === field)?.sourceColumn ?? null, code: 'conflict', message: message('usedByOtherFamily') });
      };
      claim(customers, person.stripeCustomerId, 'stripeCustomerId');
      claim(methods, person.stripePaymentMethodId, 'stripePaymentMethodId');
    }
  }
  const index = { people, families, familyKeys };
  if (!fileIndexes.has(source)) fileIndexes.set(source, new Map());
  fileIndexes.get(source)!.set(cacheKey, index);
  return index;
}

interface Existing { id: string; householdId: string }
async function existingMembers(tx: Reader, people: readonly Person[]): Promise<Map<string, Existing[]>> {
  const lastNames = [...new Set(people.flatMap((person) => person.lastName ? [person.lastName] : []))];
  const found = new Map<string, Existing[]>();
  if (!lastNames.length) return found;
  // Anonymized members are never matched or updated. Every identity includes the last name.
  const rows = await tx.select({ id: members.id, householdId: members.householdId, firstName: members.firstName, lastName: members.lastName,
    email: members.email, dateOfBirth: members.dateOfBirth }).from(members)
    .where(and(isNull(members.anonymizedAt), or(...lastNames.map((name) => ilike(members.lastName, search(name)))))).orderBy(asc(members.id));
  for (const row of rows) for (const key of knownKeys(row)) found.set(key, [...(found.get(key) ?? []),{ id: row.id, householdId: row.householdId }]);
  return found;
}
function matches(found: Map<string, Existing[]>, person: Person): Existing[] {
  const result = new Map<string, Existing>();
  for (const key of lookupKeys(person)) for (const member of found.get(key) ?? []) result.set(member.id, member);
  return [...result.values()];
}

async function analyze(tx: Reader, rows: readonly CsvRow[], plan: ImportPlanRequest, context: MapperContext): Promise<PlannedRow[]> {
  const today = context.clock.now().toISOString().slice(0, 10), file = fileIndex(context.sourceRows, plan, today);
  const chunk = rows.map((row) => file.people.get(row.rowNumber) ?? mapPerson(row, plan.mapping, { dateOrder: null, today }));
  const familyFor = (person: Person) => file.families.get(file.familyKeys.get(person.rowNumber)!)!;
  const families = [...new Set(chunk.map(familyFor))];
  const found = await existingMembers(tx, families.flatMap((family) => family.people));
  const customers = [...new Set(families.flatMap((family) => family.stripeCustomerId ? [family.stripeCustomerId] : []))];
  const customerHouseholds = new Map((customers.length ? await tx.select({ id: households.id, customer: households.stripeCustomerId })
    .from(households).where(inArray(households.stripeCustomerId, customers)) : []).map((row) => [row.customer!, row.id]));
  // Every existing identity and the saved customer must agree on one household.
  const familyHouseholds = new Map(families.map((family) => {
    const candidates = new Set(family.people.flatMap((person) => matches(found, person).map((member) => member.householdId)));
    const customerHome = family.stripeCustomerId ? customerHouseholds.get(family.stripeCustomerId) : undefined;
    if (customerHome) candidates.add(customerHome);
    return [family.key, [...candidates]];
  }));
  const targets = chunk.map((person) => {
    const duplicates = matches(found, person);
    // An update stays in the member's own household; moving members is a staff decision.
    return { person, duplicates, householdId: duplicates.length === 1 ? duplicates[0]!.householdId
      : duplicates.length ? null : familyHouseholds.get(familyFor(person).key)?.[0] ?? null };
  });
  const householdIds = [...new Set(targets.flatMap((target) => target.householdId ? [target.householdId] : []))];
  const householdCustomers = new Map((householdIds.length ? await tx.select({ id: households.id, customer: households.stripeCustomerId })
    .from(households).where(inArray(households.id, householdIds)) : []).map((row) => [row.id, row.customer]));
  const methodIds = [...new Set(chunk.flatMap((person) => person.stripePaymentMethodId ? [person.stripePaymentMethodId] : []))];
  const methodOwners = new Map((methodIds.length ? await tx.select({ id: paymentMethods.processorId, householdId: paymentMethods.householdId })
    .from(paymentMethods).where(inArray(paymentMethods.processorId, methodIds)) : []).map((row) => [row.id, row.householdId]));
  const column = (field: string) => plan.mapping.find((item) => item.targetField === field)?.sourceColumn ?? null;
  return targets.map(({ person, duplicates, householdId }) => {
    const family = familyFor(person), issues: ImportIssue[] = [...person.issues];
    const issue = (field: string, code: ImportIssue['code'], key: string) => issues.push({ rowNumber: person.rowNumber, column: column(field), code, message: message(key) });
    if ((familyHouseholds.get(family.key)?.length ?? 0) > 1) issue('householdExternalId', 'conflict', 'ambiguousFamily');
    const customer = family.stripeCustomerId, current = householdId ? householdCustomers.get(householdId) ?? null : null;
    if (customer) {
      const owner = customerHouseholds.get(customer);
      if (owner !== undefined && owner !== householdId) issue('stripeCustomerId', 'conflict', 'customerInUse');
      else if (current && current !== customer) issue('stripeCustomerId', 'conflict', 'customerConflict');
    }
    if (person.stripePaymentMethodId) {
      const owner = methodOwners.get(person.stripePaymentMethodId);
      if (owner !== undefined && owner !== householdId) issue('stripePaymentMethodId', 'conflict', 'paymentMethodInUse');
      if (!customer && !current) issue('stripeCustomerId', 'missing_required', 'paymentMethodNeedsCustomer');
    }
    const values: ImportPreviewRow['values'] = Object.fromEntries(Object.entries({
      externalId: person.externalId, firstName: person.firstName, lastName: person.lastName, email: person.email,
      dateOfBirth: person.dateOfBirth, status: person.status, phone: person.phone, emailOptOut: person.emailOptOut,
      tags: person.tags.length ? person.tags.join('; ') : null, householdExternalId: person.householdExternalId,
      householdName: family.name, householdEmail: family.email, householdPhone: family.phone, billingDay: family.billingDay,
      stripeCustomerId: customer, stripePaymentMethodId: person.stripePaymentMethodId, householdId, familyKey: family.key,
    }).filter(([, value]) => value !== null));
    return { rowNumber: person.rowNumber, values, action: issues.length ? 'error' : 'create', duplicateIds: duplicates.map((member) => member.id), issues };
  });
}

/** Typed access to the values `analyze` produced; commit never re-reads the source. */
function planned(row: PlannedRow) {
  const text = (key: string) => typeof row.values[key] === 'string' ? row.values[key] as string : null;
  return {
    externalId: text('externalId'), firstName: text('firstName')!, lastName: text('lastName')!, email: text('email'),
    dateOfBirth: text('dateOfBirth'), status: text('status') as MemberStatus | null, phone: text('phone'),
    emailOptOut: typeof row.values.emailOptOut === 'boolean' ? row.values.emailOptOut : null,
    tags: text('tags')?.split('; ') ?? [], householdExternalId: text('householdExternalId'), householdName: text('householdName')!,
    householdEmail: text('householdEmail'), householdPhone: text('householdPhone'),
    billingDay: typeof row.values.billingDay === 'number' ? row.values.billingDay : null,
    stripeCustomerId: text('stripeCustomerId'), stripePaymentMethodId: text('stripePaymentMethodId'), householdId: text('householdId'), familyKey: text('familyKey')!,
  };
}

async function commit(tx: Transaction, rows: readonly PlannedRow[], context: MapperContext): Promise<number> {
  const now = context.clock.now();
  // Audits name the import run and the target, never personal details.
  const audit = (action: string, targetType: string, targetId: string) => writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType, targetId, after: { importId: context.runId }, occurredAt: now });
  const created = new Map<string, string>();
  let tags: Map<string, string> | undefined;
  for (const row of rows) {
    const value = planned(row);
    let memberId: string, householdId: string;
    if (row.action === 'update') {
      memberId = row.duplicateIds[0]!;
      const [current] = await tx.select({ householdId: members.householdId, firstName: members.firstName, lastName: members.lastName,
        email: members.email, phone: members.phone, dateOfBirth: members.dateOfBirth, status: members.status, emailOptOut: members.emailOptOut,
        anonymizedAt: members.anonymizedAt, revision: members.revision }).from(members).where(eq(members.id, memberId)).for('update');
      if (!current || current.anonymizedAt) throw new Error('Import target member is unavailable');
      householdId = current.householdId;
      const changes = Object.fromEntries(Object.entries({ firstName: value.firstName, lastName: value.lastName, email: value.email,
        phone: value.phone, dateOfBirth: value.dateOfBirth, status: value.status, emailOptOut: value.emailOptOut })
        .filter(([key, next]) => next !== null && current[key as keyof typeof current] !== next));
      if (Object.keys(changes).length) {
        const guard = revisionGuard(members.revision, current.revision);
        assertRevised(await tx.update(members).set({ ...changes, revision: guard.next })
          .where(and(eq(members.id, memberId), guard.matches, isNull(members.anonymizedAt))).returning({ id: members.id }));
        await audit('member.updated', 'member', memberId);
      }
    } else {
      const family = value.familyKey;
      householdId = value.householdId ?? created.get(family) ?? '';
      if (!householdId) {
        householdId = uuidv7();
        await tx.insert(households).values({ id: householdId, gymId: context.gymId, name: value.householdName, email: value.householdEmail,
          phone: value.householdPhone, stripeCustomerId: value.stripeCustomerId, ...(value.billingDay ? { billingDay: value.billingDay } : {}), createdAt: now });
        await audit('household.created', 'household', householdId);
        created.set(family, householdId);
      }
      memberId = uuidv7();
      await tx.insert(members).values({ id: memberId, gymId: context.gymId, householdId, firstName: value.firstName, lastName: value.lastName,
        email: value.email, phone: value.phone, dateOfBirth: value.dateOfBirth, ...(value.status ? { status: value.status } : {}),
        ...(value.emailOptOut !== null ? { emailOptOut: value.emailOptOut } : {}), createdAt: now });
      await audit('member.created', 'member', memberId);
    }
    // Existing households gain a missing Stripe customer; an update also applies the billing day.
    const [home] = await tx.select({ customer: households.stripeCustomerId, billingDay: households.billingDay, revision: households.revision })
      .from(households).where(eq(households.id, householdId)).for('update');
    if (!home) throw new Error('Import household is unavailable');
    if (value.stripeCustomerId && home.customer && home.customer !== value.stripeCustomerId) throw new Error('Household has another Stripe customer');
    const householdChanges = { ...(value.stripeCustomerId && !home.customer ? { stripeCustomerId: value.stripeCustomerId } : {}),
      ...(row.action === 'update' && value.billingDay && value.billingDay !== home.billingDay ? { billingDay: value.billingDay } : {}) };
    if (Object.keys(householdChanges).length) {
      const guard = revisionGuard(households.revision, home.revision);
      assertRevised(await tx.update(households).set({ ...householdChanges, revision: guard.next })
        .where(and(eq(households.id, householdId), guard.matches)).returning({ id: households.id }));
      await audit('household.updated', 'household', householdId);
    }
    if (value.tags.length) {
      tags ??= new Map((await tx.select({ id: memberTags.id, name: memberTags.name }).from(memberTags)).map((tag) => [tagKey(tag.name), tag.id]));
      for (const name of value.tags) {
        let tagId = tags.get(tagKey(name));
        if (!tagId) {
          const [tag] = await tx.insert(memberTags).values({ id: uuidv7(), gymId: context.gymId, name, createdAt: now }).onConflictDoNothing().returning({ id: memberTags.id });
          if (tag) await audit('member_tag.created', 'member_tag', tag.id);
          tagId = tag?.id ?? (await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.name, name)))[0]!.id;
          tags.set(tagKey(name), tagId);
        }
        const [link] = await tx.insert(memberTagLinks).values({ id: uuidv7(), gymId: context.gymId, memberId, tagId, createdAt: now })
          .onConflictDoNothing().returning({ id: memberTagLinks.id });
        if (link) await audit('member.tag.added', 'member', memberId);
      }
    }
    // Saved payment methods are stored for later billing; importing never charges them.
    if (value.stripePaymentMethodId) {
      const [method] = await tx.select({ householdId: paymentMethods.householdId }).from(paymentMethods)
        .where(eq(paymentMethods.processorId, value.stripePaymentMethodId));
      if (method && method.householdId !== householdId) throw new Error('Payment method belongs to another household');
      if (!method) {
        const [preferred] = await tx.select({ id: paymentMethods.id }).from(paymentMethods)
          .where(and(eq(paymentMethods.householdId, householdId), eq(paymentMethods.isDefault, true))).for('update');
        const id = uuidv7();
        await tx.insert(paymentMethods).values({ id, gymId: context.gymId, householdId, processorId: value.stripePaymentMethodId,
          isDefault: !preferred, createdAt: now });
        await audit('payment_method.created', 'payment_method', id);
      }
    }
  }
  return rows.length;
}

export const peopleMapper: CsvMapper = { id: 'people', available: true, analyze, commit };
