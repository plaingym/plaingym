// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as files from './backups.files.js';
import { atomicJson } from './backups.files.js';
import { RestoreGate } from './restore.gate.js';
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('closes admission, drains admitted work, and stays closed across process restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  let release!: () => void, admitted!: () => void;
  const admission = new Promise<void>((resolve) => { admitted = resolve; });
  const active = gate.activity(async () => { admitted(); await new Promise<void>((resolve) => { release = resolve; }); });
  await admission;
  await atomicJson(gate.statePath, { phase: 'verified' });
  let drained = false;
  const closing = new RestoreGate(root).close().then(() => { drained = true; });
  await expect(gate.activity(async () => undefined)).rejects.toThrow('Restore in progress');
  expect(drained).toBe(false);
  expect(await new RestoreGate(root).isClosed()).toBe(true);
  release(); await active; await closing;
  expect(drained).toBe(true);
  await atomicJson(gate.statePath, { phase: 'complete' });
  gate.reopen();
  expect(await gate.isClosed()).toBe(false);
});
it.each(['EPERM', 'EBUSY'])('retries a transient %s without skipping active work', async (code) => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  let release!: () => void, admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const active = gate.activity(async () => { admitted(); await new Promise<void>(resolve => { release = resolve; }); });
  await admission;
  const original = files.readJson;
  let read!: () => void;
  const retried = new Promise<void>(resolve => { read = resolve; });
  const spy = vi.spyOn(files, 'readJson').mockRejectedValueOnce(Object.assign(new Error('Transient read'), { code }))
    .mockImplementation(async path => { const value = await original(path); read(); return value; });
  let drained = false;
  const closing = new RestoreGate(root).close().then(() => { drained = true; });
  try {
    await retried;
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(drained).toBe(false);
  } finally { release(); await active; await closing; }
});
it.each(['EPERM', 'EBUSY'])('stops after bounded retries for persistent %s', async code => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  await atomicJson(join(gate.activityDirectory, 'abc.json'), { pid: process.pid, started: null });
  const spy = vi.spyOn(files, 'readJson').mockRejectedValue(Object.assign(new Error('Unreadable lease'), { code }));
  await expect(gate.close()).rejects.toMatchObject({ code });
  expect(spy).toHaveBeenCalledTimes(6);
});
it('ignores a lease that disappears during the retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  await atomicJson(join(gate.activityDirectory, 'abc.json'), { pid: process.pid, started: null });
  vi.spyOn(files, 'readJson').mockRejectedValueOnce(Object.assign(new Error('Transient read'), { code: 'EPERM' }))
    .mockRejectedValueOnce(Object.assign(new Error('Gone'), { code: 'ENOENT' }));
  await expect(gate.close()).resolves.toBeUndefined();
});
