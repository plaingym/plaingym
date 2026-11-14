// SPDX-License-Identifier: AGPL-3.0-only
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as files from './backups.files.js';
import { RestoreGate } from './restore.gate.js';

const children: { child: ChildProcess; exited: Promise<void> }[] = [], directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child, exited } of children.splice(0)) { child.kill('SIGKILL'); await exited; }
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
function message(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', received); child.off('exit', exited); child.off('error', failed); };
    const received = (value: unknown) => { if (value === expected) { cleanup(); resolve(); } };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error('Lease process exited before ' + expected));
    const timer = setTimeout(() => failed(new Error('Timed out waiting for ' + expected)), 10_000);
    child.on('message', received); child.on('exit', exited); child.on('error', failed);
  });
}
async function processGate() {
  const root = await mkdtemp(join(tmpdir(), 'restore-process-')); directories.push(root);
  const child = fork(fileURLToPath(new URL('./restore.gate-process.test-helper.ts', import.meta.url)), [root], {
    execArgv: ['--import', import.meta.resolve('tsx')], windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  children.push({ child, exited });
  await message(child, 'ready');
  return { root, child, exited, gate: new RestoreGate(root), async command(command: string, expected = command) {
    const answer = message(child, expected); child.send(command); await answer;
  } };
}

it('lets the CLI drain a busy process without admitting another request after durable closure', async () => {
  const p = await processGate();
  await p.command('hold', 'active');
  await files.atomicJson(p.gate.statePath, { phase: 'verified' });
  const original = files.readJson;
  let scanned!: () => void;
  const scan = new Promise<void>(resolve => { scanned = resolve; });
  vi.spyOn(files, 'readJson').mockImplementation(async path => { const value = await original(path); scanned(); return value; });
  let drained = false;
  const closing = p.gate.close().then(() => { drained = true; });
  await scan;
  try {
    await p.command('try', 'refused');
    expect(drained).toBe(false);
  } finally { await p.command('release', 'released'); await closing; }
  expect(await readdir(p.gate.activityDirectory)).toEqual([]);
});

it('drains an idle process lease and registers a fresh lease after the CLI completes', async () => {
  const p = await processGate();
  await p.command('idle');
  expect(await readdir(p.gate.activityDirectory)).toHaveLength(1);
  await files.atomicJson(p.gate.statePath, { phase: 'verified' });
  await p.gate.close();
  expect(await readdir(p.gate.activityDirectory)).toEqual([]);
  await p.command('try', 'refused');
  await files.atomicJson(p.gate.statePath, { phase: 'complete' });
  await p.command('idle');
  expect(await readdir(p.gate.activityDirectory)).toHaveLength(1);
});

it('removes a crashed process lease by PID instead of waiting for its in-memory count', async () => {
  const p = await processGate();
  await p.command('hold', 'active');
  expect(await readdir(p.gate.activityDirectory)).toHaveLength(1);
  p.child.kill('SIGKILL'); await p.exited;
  await files.atomicJson(p.gate.statePath, { phase: 'verified' });
  await p.gate.close();
  expect(await readdir(p.gate.activityDirectory)).toEqual([]);
});

it('drains an idle process with a malformed journal so the CLI can report the journal failure', async () => {
  const p = await processGate();
  await p.command('idle');
  await writeFile(p.gate.statePath, '{');
  await p.gate.close();
  expect(await readdir(p.gate.activityDirectory)).toEqual([]);
  await expect(new RestoreGate(p.root).isClosed()).rejects.toThrow('The restore journal is not in a format this version reads');
});
