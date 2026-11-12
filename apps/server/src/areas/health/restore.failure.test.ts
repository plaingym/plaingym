// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { beforeAll, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { decrypt, encrypt } from '../../infra/age/index.js';
import { atomicJson, bytesStream, readJson } from './backups.files.js';
import { snapshotPrefix, manifestSchema, signReferences, type Snapshot, type Manifest } from './backups.format.js';
import { reportMaintenanceFailure } from '../../cli/restore.failure.js';
import { setLogSink } from '../../core/log.js';
import { PostgresMaintenance } from './backups.database.js';
import { RestoreService, enqueueRestoreReconciliation } from './restore.js';
import { RestoreFailure } from './restore.failure.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const f = useRestoreFixture({ shared: true });
const invalidLease = 'The restore activity lease is invalid; stop the app, delete the restore-activity folder on its data volume, then start the app';
let base: string;
beforeAll(async () => { base = (await f.prepare(() => f.backup().snapshot())).id; });
async function rejects(action: Promise<unknown>, message: string) {
  const error: unknown = await action.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(RestoreFailure);
  expect((error as Error).message).toBe(message);
  const lines: string[] = [], previous = setLogSink(() => undefined);
  try { reportMaintenanceFailure(['restore'], error, line => lines.push(line)); }
  finally { setLogSink(previous); }
  expect(lines).toEqual(['Restore failed: ' + message]);
}
async function changeManifest(change: (manifest: Manifest) => void) {
  const key = snapshotPrefix(base) + 'manifest.age';
  const manifest = manifestSchema.parse(JSON.parse(await new Response(await decrypt(f.identity, (await f.store.getObject(key))!)).text()));
  change(manifest);
  await f.store.putObject(key, await encrypt(f.recipient, bytesStream(JSON.stringify(manifest))));
}
async function stage() {
  await expect(f.restore(phase => { if (phase === 'verified') throw new Error('Interrupted'); }).restore(base, f.identity)).rejects.toThrow('Interrupted');
  return await readJson(f.gate().statePath) as { id: string; staging: string; currentKey: string; uploads: string; phase: string };
}
it('rejects a manifest belonging to another snapshot', async () => {
  await changeManifest(manifest => { manifest.id = randomUUID(); });
  await rejects(f.restore().restore(base, f.identity), 'Manifest belongs to another snapshot');
});
it('rejects manifest and reference disagreement', async () => {
  await changeManifest(manifest => { manifest.startedAt = '2026-10-21T00:00:00.000Z'; });
  await rejects(f.restore().restore(base, f.identity), 'Manifest and authenticated references disagree');
});
it('rejects a missing snapshot object', async () => {
  await f.store.deleteObject(snapshotPrefix(base) + 'manifest.age');
  await rejects(f.restore().restore(base, f.identity), 'A snapshot object is missing from the bucket');
});
it('rejects a second restore while one is staged', async () => {
  await stage();
  await rejects(f.restore().restore(base, f.identity), 'A verified restore is already staged; resume it first');
});
it.each([
  ['id', (): string => randomUUID(), 'Restore journal does not match staged snapshot'],
  ['currentKey', (): string => '00'.repeat(32), 'Current install key changed during restore'],
  ['uploads', (): string => 'store', 'Upload storage changed during restore'],
] as const)('rejects changed journal %s', async (field, value, message) => {
  const state = await stage();
  state[field] = value();
  await atomicJson(f.gate().statePath, state);
  await rejects(f.restore().resume(), message);
});
it('rejects an invalid journal', async () => {
  await atomicJson(f.gate().statePath, { phase: 'verified' });
  await rejects(f.restore().resume(), 'The restore journal is not in a format this version reads');
});
it.each([false, true])('rejects an invalid activity lease (invalid JSON: %s)', async invalidJson => {
  const path = join(f.gate().activityDirectory, randomUUID() + '.json');
  await atomicJson(path, { pid: 'private-value' });
  if (invalidJson) await writeFile(path, '{');
  await rejects(f.gate().close(), invalidLease);
});
it('finishes a staged restore once the invalid lease folder is deleted, as its reason says', async () => {
  await stage();
  await atomicJson(join(f.gate().activityDirectory, randomUUID() + '.json'), { pid: 'private-value' });
  // Every start resumes first, so until the folder goes the app can't start.
  await rejects(f.restore().resume(), invalidLease);
  await rejects(f.restore().resume(), invalidLease);
  expect(await f.gate().hasStagedRestore()).toBe(true);
  // With the app stopped no lease is live: deleting the folder is the documented step.
  await rm(f.gate().activityDirectory, { recursive: true, force: true });
  await f.restore().resume();
  expect(await f.gate().isClosed()).toBe(false);
  expect((await f.secretRows()).gym.billingEnabled).toBe(false);
});
it.skipIf(process.platform === 'win32')('keeps the staging of a journal whose rename landed before its directory sync failed', async () => {
  const open = files.open, target = join(f.root, 'target');
  let failed = false;
  // atomicJson syncs the journal's directory after the rename (not on Windows): fail that sync once.
  const spy = vi.spyOn(files, 'open').mockImplementation(async (path, ...rest) => {
    if (!failed && path === target && rest[0] === 'r') { failed = true; throw Object.assign(new Error('I/O error'), { code: 'EIO' }); }
    return await open(path, ...rest);
  });
  try { await rejects(f.restore().restore(base, f.identity), staged); }
  finally { spy.mockRestore(); }
  expect(failed).toBe(true);
  const journal = await readJson(f.gate().statePath) as { phase: string; staging: string };
  expect(journal.phase).toBe('verified');
  expect(await files.stat(join(f.root, 'target', 'staging', journal.staging, 'database.dump'))).toBeTruthy();
  expect(await f.gate().isClosed()).toBe(true);
  await f.restore().resume();
  expect(await f.gate().isClosed()).toBe(false);
  expect((await f.secretRows()).gym.billingEnabled).toBe(false);
});
it.each([false, true])('rejects an inconsistent upload switch (missing: %s)', async missing => {
  const state = await stage();
  state.phase = 'moving_new';
  await atomicJson(f.gate().statePath, state);
  if (missing) {
    await rm(join(f.root, 'target', 'staging', state.staging, 'uploads'), { recursive: true });
    await rm(join(f.root, 'target', 'uploads'), { recursive: true });
  }
  await rejects(f.restore().resume(), missing ? 'Restored uploads tree missing' : 'Unexpected uploads directory during restore');
});
it('rejects an invalid current key and staging inside uploads', () => {
  const options = f.restore().options;
  for (const [override, message] of [
    [{ appEncryptionKey: Buffer.alloc(1) }, 'Invalid current app key'],
    [{ stagingDirectory: options.uploadsDirectory }, 'Restore staging must be outside uploads'],
  ] as const) {
    expect(() => new RestoreService({ ...options, ...override })).toThrow(RestoreFailure);
    expect(() => new RestoreService({ ...options, ...override })).toThrow(message);
  }
});
it('rejects the wrong maintenance role by type', () => {
  expect(() => new PostgresMaintenance('postgres://app:unused@localhost/unused')).toThrow(RestoreFailure);
});
it('rejects staging on a different filesystem', async () => {
  const stat = files.stat;
  const spy = vi.spyOn(files, 'stat').mockImplementation(async (path) => {
    const result = await stat(path);
    if (String(path).includes('restore-')) result.dev += 1;
    return result;
  });
  try { await rejects(f.restore().restore(base, f.identity), 'Restore staging and uploads must share a filesystem'); }
  finally { spy.mockRestore(); }
});
it('rejects a missing restored gym receipt', async () => {
  await rejects(enqueueRestoreReconciliation(f.sourceMaintenance, f.clock.now().toISOString(), f.clock), 'Restored gym receipt is missing');
});

const damaged = 'The snapshot is damaged; try an earlier one';
const staged = 'The staged restore failed; preserve the restore state and check the server before retrying resume';
it.each(['missing', 'oversized', 'truncated', 'authentication', 'wrong snapshot', 'duplicate'])(
  'reports damaged references: %s', async kind => {
    const key = snapshotPrefix(base) + 'references.json';
    if (kind === 'missing') await f.store.deleteObject(key);
    else if (kind === 'oversized') await f.store.putObject(key, bytesStream(' '.repeat(16 * 1024 * 1024 + 1)));
    else if (kind === 'truncated') await f.store.putObject(key, bytesStream('{PRIVATE-CONTENT'));
    else {
      const envelope = JSON.parse(await new Response((await f.store.getObject(key))!).text()) as { payload: string; mac: string };
      const snapshot = JSON.parse(envelope.payload) as Snapshot;
      if (kind === 'wrong snapshot') snapshot.id = randomUUID();
      if (kind === 'duplicate') snapshot.uploads.push(snapshot.uploads[0]!);
      await f.store.putObject(key, bytesStream(kind === 'authentication'
        ? JSON.stringify({ ...envelope, mac: '00'.repeat(32) }) : signReferences(snapshot, f.blobKey)));
    }
    await rejects(f.restore().restore(base, f.identity), damaged);
    expect(await f.gate().isClosed()).toBe(false);
  });
it.each(['manifest.age', 'database.age', 'blob'])('reports corrupted %s before activation', async name => {
  const key = name === 'blob' ? [...f.server.objects.keys()].find(key => key.startsWith('backups/blobs/'))!.slice('backups/'.length) : snapshotPrefix(base) + name;
  await f.store.putObject(key, bytesStream('PRIVATE-CORRUPTED-CONTENT'));
  await rejects(f.restore().restore(base, f.identity), damaged);
  expect(await f.gate().isClosed()).toBe(false);
});
it('reports an invalid upload reference from the decrypted manifest', async () => {
  await changeManifest(manifest => { manifest.uploads[0]!.key = '../PRIVATE-CONTENT'; });
  await rejects(f.restore().restore(base, f.identity), damaged);
});
it('reports oversized decrypted metadata before activation', async () => {
  await f.store.putObject(snapshotPrefix(base) + 'manifest.age',
    await encrypt(f.recipient, bytesStream(' '.repeat(16 * 1024 * 1024 + 1))));
  await rejects(f.restore().restore(base, f.identity), damaged);
});
it.each(['references.json', 'database.dump', 'manifest.json'])('reports corrupted staged %s without earlier-snapshot advice', async name => {
  const state = await stage();
  await writeFile(join(f.root, 'target', 'staging', state.staging, name), 'PRIVATE-CONTENT');
  await rejects(f.restore().resume(), staged);
  expect(await f.gate().hasStagedRestore()).toBe(true);
});
it.each(['{PRIVATE-CONTENT', ' '.repeat(16 * 1024 * 1024 + 1)])('reports unreadable journal contents %#', async contents => {
  await stage();
  await writeFile(f.gate().statePath, contents);
  const message = 'The restore journal is not in a format this version reads';
  await rejects(f.gate().isClosed(), message);
  await rejects(f.restore().resume(), message);
});
it('keeps a coded read failure of the journal apart from its format', async () => {
  await stage();
  const denied = Object.assign(new Error('Denied'), { code: 'EACCES' }), readFile = files.readFile;
  const spy = vi.spyOn(files, 'readFile').mockImplementation(async (path, options) => {
    if (path === f.gate().statePath) throw denied;
    return await readFile(path, options);
  });
  try {
    await expect(f.gate().isClosed()).rejects.toBe(denied);
    await rejects(f.restore().resume(), staged);
  } finally { spy.mockRestore(); }
});
it('reports a manifest this version cannot read as a format problem, not damage', async () => {
  await changeManifest(manifest => { (manifest as { version: number }).version = 2; });
  const error = await f.restore().restore(base, f.identity).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ZodError);
  const lines: string[] = [], previous = setLogSink(() => undefined);
  try { reportMaintenanceFailure(['restore'], error, line => lines.push(line)); }
  finally { setLogSink(previous); }
  expect(lines).toEqual(["Restore failed: The snapshot's contents are not in a format this version reads"]);
});
it('keeps the cause of a wrapped failure in the log, never in the printed line or its message', async () => {
  await f.store.putObject(snapshotPrefix(base) + 'references.json', bytesStream('{PRIVATE-CONTENT'));
  const error = await f.restore().restore(base, f.identity).catch((failure: unknown) => failure);
  const logged: string[] = [], lines: string[] = [], previous = setLogSink(line => logged.push(line));
  try { reportMaintenanceFailure(['restore'], error, line => lines.push(line)); }
  finally { setLogSink(previous); }
  expect(lines).toEqual(['Restore failed: ' + damaged]);
  expect(logged.join()).toContain('"cause":{"name":"SyntaxError"');
  expect(logged.join()).not.toContain('PRIVATE-CONTENT');
});
it('reports an oversized lease without snapshot advice', async () => {
  const path = join(f.gate().activityDirectory, randomUUID() + '.json');
  await atomicJson(path, {});
  await writeFile(path, ' '.repeat(16 * 1024 * 1024 + 1));
  await rejects(f.gate().close(), invalidLease);
});
it.each([false, true])('reports a failed database tool after activation (resume: %s)', async resume => {
  if (resume) await stage();
  const database = new PostgresMaintenance(f.targetMaintenance.url, (tool, env) => ({
    command: process.execPath, args: ['-e', 'process.exit(1)'], env,
  }));
  const service = new RestoreService({ ...f.restore().options, database });
  await rejects(resume ? service.resume() : service.restore(base, f.identity), staged);
  expect(await f.gate().hasStagedRestore()).toBe(true);
});
