// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { scopedDatabase, Transaction } from '../client.js';
import { uuidv7 } from '../id.js';
import * as schema from '../schema/index.js';
type TableName = keyof typeof schema;
type Insert<K extends TableName> = (typeof schema)[K]['$inferInsert'];
type Row<K extends TableName> = (typeof schema)[K]['$inferSelect'];
const date = new Date('2026-01-15T12:00:00Z');
const snapshot = '{"body":"I agree.","signer":"Test Member","version":1}';
const defaults = {
  gyms: () => ({ name: 'Test Gym', slug: uuidv7() }),
  gymDomains: () => ({ hostname: uuidv7() + '.example.test' }),
  authUser: () => ({ name: 'Test User', email: uuidv7() + '@example.test' }),
  authSession: () => ({ token: uuidv7(), expiresAt: new Date('2026-02-01Z') }),
  authAccount: () => ({ accountId: uuidv7(), providerId: 'credential' }),
  authVerification: () => ({ identifier: uuidv7(), value: 'hashed-test-value', expiresAt: new Date('2026-02-01Z') }),
  authRateLimit: () => ({ key: uuidv7(), count: 1, lastRequest: date.getTime() }),
  households: () => ({ name: 'Test Household' }),
  householdUsers: () => ({ scope: 'payer' }),
  members: () => ({ firstName: 'Test', lastName: 'Member' }),
  memberTags: () => ({ name: uuidv7() }), memberTagLinks: () => ({}),
  staffRoles: () => ({ role: 'coach' }), staffProfiles: () => ({ displayName: 'Test Coach' }),
  installedPacks: () => ({ packId: uuidv7(), version: 1 }),
  rankSystems: () => ({ name: 'Test progression' }), programs: () => ({ name: uuidv7() }),
  ranks: () => ({ name: 'Level 1', position: 0 }), memberRanks: () => ({ promotedAt: date }),
  classTags: () => ({ name: uuidv7() }),
  classTemplates: () => ({ name: 'Test Class', weekday: 1, localStartTime: '18:00', durationMinutes: 60 }),
  classTemplatePrograms: () => ({}), classTemplateTags: () => ({}),
  classSessions: () => ({ name: 'Test Class', startsAt: date, endsAt: new Date('2026-01-15T13:00:00Z') }),
  classSessionPrograms: () => ({}), classSessionTags: () => ({}),
  attendances: () => ({ occurredAt: date, source: 'coach' }),
  classBookings: () => ({ bookedByKind: 'staff' }),
  taxRates: () => ({ name: 'Test tax', basisPoints: 500 }),
  plans: () => ({ name: 'Test Plan', amountCents: 10000, currency: 'USD', interval: 'monthly' }),
  chargeTypes: () => ({ name: 'Test Charge', amountCents: 2000, currency: 'USD' }),
  memberships: () => ({ interval: 'monthly', amountCents: 10000, currency: 'USD', nextDueOn: '2026-02-15', startsOn: '2026-01-15' }),
  invoices: () => ({ kind: 'one_off', dueOn: '2026-01-15', amountCents: 10000, currency: 'USD' }),
  invoiceLineItems: () => ({ kind: 'charge', description: 'Test charge', amountCents: 10000, currency: 'USD' }),
  paymentMethods: () => ({ processorId: 'pm_' + uuidv7(), brand: 'visa', last4: '4242' }),
  paymentAttempts: () => ({ attemptNumber: 1, amountCents: 10000, currency: 'USD', savedPaymentMethod: 'pm_test', stripeCustomerId: 'cus_test' }),
  payments: () => ({ method: 'cash', amountCents: 10000, currency: 'USD', paidAt: date }),
  refunds: () => ({ amountCents: 1000, currency: 'USD' }),
  waiverTemplates: () => ({ name: uuidv7(), version: 1, body: 'I agree.' }),
  waiverSignatures: () => ({ snapshot, snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
    signatureImageKey: 'test/signature.png', signatureImageHash: 'a'.repeat(64), signedAt: date, ipAddress: '127.0.0.1' }),
  kioskDevices: () => ({ name: 'Test Kiosk', tokenHash: uuidv7() }),
  linkCampaigns: () => ({ name: 'Test campaign', purpose: 'update_card' }),
  signedLinks: () => ({ tokenHash: createHash('sha256').update(uuidv7()).digest('hex'), purpose: 'update_card', expiresAt: new Date('2026-02-01Z') }),
  jobs: () => ({ name: 'test', runAt: date, idempotencyKey: uuidv7() }),
  backupRuns: () => ({ kind: 'manual', startedAt: date, objectPrefix: uuidv7() }),
  stripeEvents: () => ({ eventId: 'evt_' + uuidv7(), type: 'test.event', payload: {} }),
  auditEvents: () => ({ actorKind: 'system', action: 'test.created', targetType: 'test', targetId: uuidv7(), occurredAt: date }),
  emailOutbox: () => ({ recipient: 'test@example.test', subject: 'Test', html: '<p>Test</p>', text: 'Test', sentAt: date }),
} satisfies { [K in TableName]: () => Partial<Insert<K>> };
export const factoryTableNames = Object.keys(defaults) as TableName[];
const bySqlName = new Map<string, TableName>(Object.entries(schema).map(([key, table]) => [getTableName(table), key as TableName]));
/** Required dependencies are inserted in the same gym; optional relationships remain empty. */
export function createFactories(database: Pick<ReturnType<typeof scopedDatabase>, 'forGym'>) {
  async function build(tx: Transaction, name: TableName, gymId: string, overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
    const table = schema[name];
    const columns = getTableColumns(table);
    const values: Record<string, unknown> = { ...defaults[name](), ...(name === 'gyms' ? { id: gymId } : {}),
      ...('gymId' in columns ? { gymId } : {}), ...overrides };
    const property = (table: PgTable, columnName: string) => {
      const entry = Object.entries(getTableColumns(table)).find(([, column]) => column.name === columnName);
      if (!entry) throw new Error('Unknown factory column');
      return entry[0];
    };
    for (const fk of getTableConfig(table).foreignKeys) {
      const reference = fk.reference();
      const missing = reference.columns.filter((column) => values[property(table, column.name)] === undefined);
      if (!missing.some((column) => column.notNull)) continue;
      const targetName = bySqlName.get(getTableName(reference.foreignTable));
      if (!targetName) throw new Error('Missing factory dependency');
      const supplied: Record<string, unknown> = {};
      reference.columns.forEach((column, index) => {
        const value = values[property(table, column.name)];
        if (value !== undefined) supplied[property(reference.foreignTable, reference.foreignColumns[index]!.name)] = value;
      });
      const related = await build(tx, targetName, gymId, supplied);
      reference.columns.forEach((column, index) => {
        values[property(table, column.name)] = related[property(reference.foreignTable, reference.foreignColumns[index]!.name)];
      });
    }
    const [row] = await tx.insert(table as PgTable).values(values).returning();
    if (!row) throw new Error('Factory insert returned no row');
    return row;
  }
  return async function factory<K extends TableName>(table: K, gymId: string, overrides: Partial<Insert<K>> = {}): Promise<Row<K>> {
    return database.forGym(gymId, async (tx) => await build(tx, table, gymId, overrides) as Row<K>);
  };
}
