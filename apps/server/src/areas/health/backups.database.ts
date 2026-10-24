// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
// Reviewed maintenance infrastructure: a dedicated connection holds the backup lock outside transactions.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { advisoryLockNamespace, advisoryLocks, encryptedFields, uuidv7, writeAudit } from '@plaingym/db';
import { migrateDatabase } from '@plaingym/db/migrate';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';

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
  /** One short, atomic database transaction. Retrying recognizes already re-encrypted envelopes. */
  async rekey(oldKey: Buffer, newKey: Buffer, clock: Clock, afterField?: (field: string) => void): Promise<void> {
    const connection = openConnection(this.url, 1);
    try {
      await connection.db.transaction(async (tx) => {
        for (const field of encryptedFields) {
          const table = sql.identifier(field.table), column = sql.identifier(field.column);
          const rows = await tx.execute<{ id: string; value: string }>(sql`select id, ${column} as value from ${table} where ${column} is not null for update`);
          for (const row of rows) {
            let plaintext: string;
            try { plaintext = decryptSecret(newKey, field.secretClass, row.value); }
            catch { plaintext = decryptSecret(oldKey, field.secretClass, row.value); }
            const value = encryptSecret(newKey, field.secretClass, plaintext);
            await tx.execute(sql`update ${table} set ${column} = ${value} where id = ${row.id}::uuid`);
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
  /** Restore receipt belongs to the external protocol, never to a table overwritten by pg_restore. */
  newId(): string { return uuidv7(); }
}
