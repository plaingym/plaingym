// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
it.each(['EPERM', 'EBUSY'])('retries a transient %s before checking a stale lease', async (code) => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  await atomicJson(join(gate.activityDirectory, 'abc.json'), { pid: process.pid, started: null });
  const original = files.readJson;
  const spy = vi.spyOn(files, 'readJson').mockRejectedValueOnce(Object.assign(new Error('Transient read'), { code }))
    .mockImplementation(original);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Gone'), { code: 'ESRCH' }); });
  await expect(gate.close()).resolves.toBeUndefined();
  expect(spy).toHaveBeenCalledTimes(2);
});
it.each(['EPERM', 'EBUSY'])('retries a transient %s without skipping a live lease', async code => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root), lease = join(gate.activityDirectory, 'abc.json');
  const stat = process.platform === 'linux' ? await readFile('/proc/' + process.pid + '/stat', 'utf8') : null;
  const started = stat === null ? null : stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
  await atomicJson(lease, { pid: process.pid, started });
  const original = files.readJson;
  let read!: () => void;
  const retried = new Promise<void>(resolve => { read = resolve; });
  const spy = vi.spyOn(files, 'readJson').mockRejectedValueOnce(Object.assign(new Error('Transient read'), { code }))
    .mockImplementation(async path => { const value = await original(path); read(); return value; });
  let drained = false;
  const closing = gate.close().then(() => { drained = true; });
  try {
    await retried;
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(drained).toBe(false);
  } finally { await rm(lease, { force: true }); await closing; }
  expect(drained).toBe(true);
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

it('writes one process lease for overlapping and sequential requests, shared by gate instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root), peer = new RestoreGate(root);
  const writes = vi.spyOn(files, 'atomicJson');
  let release!: () => void, admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const active = gate.activity(async () => { admitted(); await new Promise<void>(resolve => { release = resolve; }); });
  await admission;
  try {
    await Promise.all(Array.from({ length: 20 }, () => peer.activity(async () => undefined)));
    for (let i = 0; i < 20; i++) await gate.activity(async () => undefined);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await readdir(gate.activityDirectory)).toHaveLength(1);
  } finally { release(); await active; await gate.close(); }
  expect(await readdir(gate.activityDirectory)).toEqual([]);
  gate.reopen();
  await gate.activity(async () => undefined);
  expect(writes).toHaveBeenCalledTimes(2);
  await gate.close();
});

it('blocks an admission suspended during its first lease write when close starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  const original = files.atomicJson;
  let publish!: () => void, writing!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  vi.spyOn(files, 'atomicJson').mockImplementation(async (path, value) => {
    writing(); await new Promise<void>(resolve => { publish = resolve; });
    await original(path, value);
  });
  const action = vi.fn(async () => undefined);
  const admission = gate.activity(action);
  const refused = expect(admission).rejects.toThrow('Restore in progress');
  await started;
  let drained = false;
  const closing = new RestoreGate(root).close().then(() => { drained = true; });
  expect(drained).toBe(false);
  publish();
  await refused; await closing;
  expect(action).not.toHaveBeenCalled();
});

it('rechecks synchronous closure after an asynchronous admission check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  let resume!: (closed: boolean) => void, checked!: () => void;
  const checking = new Promise<void>(resolve => { checked = resolve; });
  vi.spyOn(gate, 'isClosed').mockResolvedValueOnce(false).mockImplementationOnce(async () => {
    checked(); return new Promise<boolean>(resolve => { resume = resolve; });
  });
  const action = vi.fn(async () => undefined);
  const admission = expect(gate.activity(action)).rejects.toThrow('Restore in progress');
  await checking;
  const closing = gate.close();
  resume(false);
  await admission; await closing;
  expect(action).not.toHaveBeenCalled();
});

it('releases its in-memory count when an action fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root), failure = new Error('Action failed');
  await expect(gate.activity(async () => { throw failure; })).rejects.toBe(failure);
  await gate.close();
  expect(await readdir(gate.activityDirectory)).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('discards a lease for a reused PID with a different process start time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-gate-')); directories.push(root);
  const gate = new RestoreGate(root);
  await atomicJson(join(gate.activityDirectory, 'abc.json'), { pid: process.pid, started: 'not-this-process' });
  await gate.close();
  expect(await readdir(gate.activityDirectory)).toEqual([]);
});
