// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
// Reviewed maintenance infrastructure: a dedicated connection holds the backup lock outside transactions.
// eslint-disable-next-line no-restricted-imports
import { openConnection, type Connection } from '@plaingym/db/client';
import { advisoryLockNamespace, advisoryLocks, encryptedFields, uuidv7, writeAudit } from '@plaingym/db';
import { migrateDatabase } from '@plaingym/db/migrate';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { reencryptSecret, type SecretClass } from '../../core/secrets.js';

type Transaction = Parameters<Parameters<Connection['db']['transaction']>[0]>[0];
type SecretField = { readonly table: string; readonly column: string; readonly secretClass: SecretClass; readonly pending?: boolean };
// Pending credentials use the same envelope context as the active S3 column when staff confirm them.
// They live in settings until then, so maintenance must also visit this JSON leaf.
const maintenanceFields: readonly SecretField[] = [...encryptedFields,
  { table: 'gyms', column: 'pending_s3_config', secretClass: 's3_config', pending: true }];
function secretColumn(field: SecretField) {
  return field.pending ? sql`settings #>> '{integrations,backup,s3Config}'` : sql`${sql.identifier(field.column)}`;
}
type SecretRow = { id: string } & Record<string, string | null>;
/** Where a stored secret that neither key opens is: its class and its row's ID, never its value. */
export interface UnreadableSecret { readonly secretClass: SecretClass; readonly owner: string }
/** A key rotation's check found stored secrets that open with neither key, so it changed nothing. */
export class UnreadableSecretsError extends Error {
  constructor(readonly unreadable: readonly UnreadableSecret[]) { super('Stored secrets open with neither key'); this.name = 'UnreadableSecretsError'; }
}
/**
 * Each table's registered secret columns; every value belongs to its row's `id`. `gyms` comes last, so a single-gym
 * install whose rotation is interrupted keeps its gym's settings under the old key until the final transaction.
 */
const secretTables = [...new Set(maintenanceFields.map((field) => field.table))]
  .sort((a, b) => Number(a === 'gyms') - Number(b === 'gyms'))
  .map((table) => ({ table, fields: maintenanceFields.filter((field) => field.table === table) }));
/** One keyset page of a table's rows that hold a registered secret (only `v1` ones with `legacyOnly`), in ID order. */
async function secretRows(tx: Transaction | Connection['db'], table: string, fields: readonly SecretField[], after: string | null,
  limit: number, options: { lock: boolean; legacyOnly: boolean }): Promise<SecretRow[]> {
  const columns = sql.join(fields.map((field) => sql`${secretColumn(field)} as ${sql.identifier(field.column)}`), sql`, `);
  const holds = sql.join(fields.map((field) => options.legacyOnly ? sql`${secretColumn(field)} like 'v1.%'`
    : sql`${secretColumn(field)} is not null`), sql` or `);
  return [...await tx.execute<SecretRow>(sql`select id, ${columns} from ${sql.identifier(table)} where (${holds})
    ${after ? sql`and id > ${after}::uuid` : sql``} order by id limit ${limit} ${options.lock ? sql`for update` : sql``}`)];
}
/** A row's values as `v2` under `to` (only those that change), and those that open with neither key. */
function rewriteRow(row: SecretRow, fields: readonly SecretField[], from: Buffer, to: Buffer) {
  const set = new Map<string, string>(), unreadable: UnreadableSecret[] = [];
  for (const field of fields) {
    const value = row[field.column];
    if (value == null) continue;
    try {
      const next = reencryptSecret(from, to, { secretClass: field.secretClass, owner: row.id }, value);
      if (next !== null) set.set(field.column, next);
    } catch {
      // Pending credentials that open with neither key stay as they are, so they never block a restore or a
      // rotation: confirming them answers that staff must generate a new backup key.
      if (!field.pending) unreadable.push({ secretClass: field.secretClass, owner: row.id });
    }
  }
  return { set, unreadable };
}
async function updateRow(tx: Transaction, table: string, id: string, set: ReadonlyMap<string, string>): Promise<void> {
  if (!set.size) return;
  const assignments = sql.join([...set].map(([column, value]) => column === 'pending_s3_config'
    ? sql`settings = jsonb_set(settings, '{integrations,backup,s3Config}', to_jsonb(${value}::text), false)`
    : sql`${sql.identifier(column)} = ${value}`), sql`, `);
  await tx.execute(sql`update ${sql.identifier(table)} set ${assignments} where id = ${id}::uuid`);
}

export interface ToolCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }
export type ToolRunner = (tool: 'pg_dump' | 'pg_restore', env: NodeJS.ProcessEnv) => ToolCommand;
const nativeTools: ToolRunner = (tool, env) => ({ command: tool, args: [], env });
export class PostgresMaintenance {
  constructor(readonly url: string, readonly tools: ToolRunner = nativeTools) {
    if (new URL(url).username !== 'maintenance') throw new Error('Backups and restore require maintenance');
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    assertNoTransaction('backup.lock');
    const connection = openConnection(this.url, 1);
    try {
      await connection.sql`select pg_advisory_lock(${advisoryLockNamespace}::int, ${advisoryLocks.backups}::int)`;
      return await action();
    } finally { await connection.close(); }
  }
  async tool(tool: 'pg_dump' | 'pg_restore', args: string[], input?: string): Promise<ReadableStream<Uint8Array>> {
    const url = new URL(this.url);
    const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: 'maintenance',
      PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10',
      ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}) };
    const command = this.tools(tool, env);
    const child = spawn(command.command, [...command.args, ...args], {
      env: command.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never forward stderr: libpq errors may contain connection details.
    child.stderr.resume();
    const exit = once(child, 'exit').then(([code]) => {
      if (code !== 0) throw new Error(tool + ' failed');
    });
    void exit.catch(() => undefined);
    const feeder = input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve(child.stdin.end()).then(() => undefined);
    void feeder.catch(() => undefined);
    const iterator = child.stdout[Symbol.asyncIterator]();
    return new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (!next.done) controller.enqueue(new Uint8Array(next.value));
          else { await feeder; await exit; controller.close(); }
        } catch { child.kill(); controller.error(new Error(tool + ' failed')); }
      },
      cancel() { child.kill(); },
    });
  }
  async dump(): Promise<ReadableStream<Uint8Array>> {
    assertNoTransaction('backup.pg_dump');
    return this.tool('pg_dump', ['--format=custom', '--compress=gzip:6', '--no-owner', '--schema=public', '--schema=drizzle']);
  }
  async restore(path: string): Promise<void> {
    assertNoTransaction('restore.pg_restore');
    const connection = openConnection(this.url, 1);
    try {
      await connection.sql.begin(async (tx) => {
        await tx`drop schema if exists public cascade`;
        await tx`drop schema if exists drizzle cascade`;
      });
    } finally { await connection.close(); }
    const output = await this.tool('pg_restore', ['--dbname=' + decodeURIComponent(new URL(this.url).pathname.slice(1)),
      '--single-transaction', '--exit-on-error', '--no-owner'], path);
    for await (const chunk of output) { void chunk; }
  }
  async migrate(): Promise<void> { await migrateDatabase(this.url); }
  /** The restored install's gyms, for restoring their object-store uploads. */
  async gymIds(): Promise<string[]> {
    const connection = openConnection(this.url, 1);
    try { return (await connection.sql<{ id: string }[]>`select id from gyms order by id`).map((row) => row.id); }
    finally { await connection.close(); }
  }
  /**
   * Restore's re-key: every registered secret from the snapshot's key to this install's, as `v2` bound to its row, in
   * one short, atomic database transaction. Retrying recognizes already re-encrypted envelopes.
   */
  async rekey(oldKey: Buffer, newKey: Buffer, clock: Clock, afterField?: (field: string) => void): Promise<void> {
    const connection = openConnection(this.url, 1);
    try {
      await connection.db.transaction(async (tx) => {
        for (const field of maintenanceFields) {
          const table = sql.identifier(field.table), column = secretColumn(field);
          const rows = await tx.execute<{ id: string; value: string }>(sql`select id, ${column} as value from ${table} where ${column} is not null for update`);
          for (const row of rows) {
            let value: string | null;
            try { value = reencryptSecret(oldKey, newKey, { secretClass: field.secretClass, owner: row.id }, row.value); }
            catch (error) { if (field.pending) continue; throw error; }
            if (value !== null) await updateRow(tx, field.table, row.id, new Map([[field.column, value]]));
          }
          afterField?.(field.secretClass);
        }
        const gyms = await tx.execute<{ id: string }>(sql`update gyms set billing_enabled = false,
          revision = revision + 1, updated_at = ${clock.now().toISOString()} returning id`);
        for (const gym of gyms) await writeAudit(tx, { gymId: gym.id, actorKind: 'system',
          action: 'restore.completed', targetType: 'gym', targetId: gym.id, occurredAt: clock.now() });
      });
    } finally { await connection.close(); }
  }
  /**
   * Rewrites registered secrets as `v2` under `to`, a gym (its `gyms` row) or a page of other rows per short
   * transaction, and returns how many values changed. A value that already opens as `v2` with `to` is left alone;
   * any other must open with `from`. With `skipUnreadable`, values that don't are left unchanged and counted;
   * otherwise one rolls back its transaction and throws. Earlier transactions stay committed, so that error is not an
   * {@link UnreadableSecretsError}, which promises nothing changed: run the rotation again.
   */
  async #rewriteSecrets(from: Buffer, to: Buffer, options: { legacyOnly: boolean; skipUnreadable: boolean; afterCommit?: (table: string) => void | Promise<void> }) {
    const connection = openConnection(this.url, 1);
    try {
      let rewritten = 0, unreadable = 0;
      for (const { table, fields } of secretTables) {
        const size = table === 'gyms' ? 1 : 100;
        for (let after: string | null = null; ;) {
          const page = await connection.db.transaction(async (tx) => {
            const rows = await secretRows(tx, table, fields, after, size, { lock: true, legacyOnly: options.legacyOnly });
            let changed = 0, skipped = 0;
            for (const row of rows) {
              const result = rewriteRow(row, fields, from, to);
              if (result.unreadable.length && !options.skipUnreadable) throw new Error('A stored secret changed during the key rotation');
              skipped += result.unreadable.length;
              await updateRow(tx, table, row.id, result.set);
              changed += result.set.size;
            }
            return { last: rows.at(-1)?.id ?? null, count: rows.length, changed, skipped };
          });
          rewritten += page.changed; unreadable += page.skipped;
          if (page.count) await options.afterCommit?.(table);
          if (page.count < size) break;
          after = page.last;
        }
      }
      return { rewritten, unreadable };
    } finally { await connection.close(); }
  }
  /**
   * The one-time step after migrations: rewrites each remaining `v1` value as `v2` under the same key, binding it to
   * the row it is in now. Values the key doesn't open stay as they are and are counted. Does nothing once all are `v2`.
   */
  async upgradeSecrets(key: Buffer): Promise<{ rewritten: number; unreadable: number }> {
    assertNoTransaction('secrets.upgrade');
    return this.#rewriteSecrets(key, key, { legacyOnly: true, skipUnreadable: true });
  }
  /**
   * Replaces the app key: re-encrypts every registered secret from `from` to `to` as `v2`. Run it with the app stopped.
   * It holds the backup lock, so no snapshot captures a half-rotated install, and first checks that every stored value
   * opens with one of the keys: if any doesn't (a wrong `from`), it throws {@link UnreadableSecretsError} and changes
   * nothing. It then commits a gym or a page of other rows at a time, and is safe to run again after a crash: a value
   * that opens as `v2` with `to` is done.
   */
  async rotateKey(from: Buffer, to: Buffer, afterCommit?: (table: string) => void | Promise<void>): Promise<{ rewritten: number }> {
    assertNoTransaction('secrets.rotate');
    if (from.length !== 32 || to.length !== 32 || from.equals(to)) throw new Error('Key rotation needs two different keys');
    return this.locked(async () => {
      const connection = openConnection(this.url, 1);
      try {
        const unreadable: UnreadableSecret[] = [];
        for (const { table, fields } of secretTables) {
          for (let after: string | null = null; ;) {
            const rows = await secretRows(connection.db, table, fields, after, 500, { lock: false, legacyOnly: false });
            for (const row of rows) unreadable.push(...rewriteRow(row, fields, from, to).unreadable);
            if (rows.length < 500) break;
            after = rows.at(-1)!.id;
          }
        }
        if (unreadable.length) throw new UnreadableSecretsError(unreadable);
      } finally { await connection.close(); }
      const { rewritten } = await this.#rewriteSecrets(from, to, { legacyOnly: false, skipUnreadable: false, ...(afterCommit ? { afterCommit } : {}) });
      // The host must not switch .env if an app restarted or wrote an old-key value into a row already passed.
      // Keep the backup lock through both checks. A failure can leave committed pages; rerun with the same keys.
      if (await this.appSessions() > 0) throw new KeyRotationIncompleteError('The app reconnected during key rotation');
      const verification = openConnection(this.url, 1);
      try {
        for (const { table, fields } of secretTables) {
          for (let after: string | null = null; ;) {
            const rows = await secretRows(verification.db, table, fields, after, 500, { lock: false, legacyOnly: false });
            // Done means nothing left to rewrite: every value opens as `v2` with `to`.
            for (const row of rows) {
              const { set, unreadable } = rewriteRow(row, fields, from, to);
              if (set.size || unreadable.length) throw new KeyRotationIncompleteError('A stored secret changed during key rotation');
            }
            if (rows.length < 500) break;
            after = rows.at(-1)!.id;
          }
        }
      } finally { await verification.close(); }
      if (await this.appSessions() > 0) throw new KeyRotationIncompleteError('The app reconnected during key rotation');
      return { rewritten };
    });
  }
  /** Open sessions of the `app` role in this database: a key rotation needs every app process stopped. */
  async appSessions(): Promise<number> {
    const connection = openConnection(this.url, 1);
    try {
      const [row] = await connection.sql<{ count: number }[]>`select count(*)::int as count from pg_stat_activity
        where datname = current_database() and usename = 'app'`;
      return row?.count ?? 0;
    } finally { await connection.close(); }
  }
  /** Restore receipt belongs to the external protocol, never to a table overwritten by pg_restore. */
  newId(): string { return uuidv7(); }
}
/** Unlike a preflight refusal, some pages may already be committed. Never discard either rotation key. */
export class KeyRotationIncompleteError extends Error {
  constructor(reason: string) {
    super(reason + '; run rotate-key.sh again to finish with the same keys');
    this.name = 'KeyRotationIncompleteError';
  }
}
