// SPDX-License-Identifier: AGPL-3.0-only
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setLogSink } from '../../core/log.js';
import * as files from './backups.files.js';
import { RestoreGate } from './restore.gate.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const directories: string[] = [], gates: RestoreGate[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const gate of gates.splice(0)) await gate.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-monitor-')); directories.push(root);
  const gate = new RestoreGate(root); gates.push(gate);
  return gate;
}

it.each([false, true])('recreates a deleted lease while the process is running (busy: %s)', async busy => {
  const gate = await fixture();
  let release!: () => void, admitted!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const active = gate.activity(async () => { admitted(); if (busy) await new Promise<void>(resolve => { release = resolve; }); });
  await entered;
  const [name] = await readdir(gate.activityDirectory), path = join(gate.activityDirectory, name!);
  try {
    await rm(path);
    await vi.waitFor(async () => { expect(await files.exists(path)).toBe(true); });
    await files.atomicJson(gate.statePath, { phase: 'verified' });
    const action = vi.fn(async () => undefined);
    await expect(gate.activity(action)).rejects.toThrow('Restore in progress');
    expect(action).not.toHaveBeenCalled();
  } finally { release?.(); await active; }
});

it('repairs a missing lease before admitting the next request, even before the monitor ticks', async () => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const [name] = await readdir(gate.activityDirectory), path = join(gate.activityDirectory, name!);
  await rm(path);
  await gate.activity(async () => { expect(await files.exists(path)).toBe(true); });
});

it('does not re-read an unchanged completed journal in the monitor and detects its replacement', async () => {
  const gate = await fixture();
  await files.atomicJson(gate.statePath, { phase: 'complete' });
  await gate.activity(async () => undefined);
  const reads = vi.spyOn(files, 'readJson'), checks = vi.spyOn(files, 'exists');
  await vi.waitFor(() => {
    expect(checks.mock.calls.filter(([path]) => path.startsWith(gate.activityDirectory)).length).toBeGreaterThanOrEqual(4);
  }, { timeout: 2_000, interval: 10 });
  expect(reads.mock.calls.filter(([path]) => path === gate.statePath)).toHaveLength(1);
  await files.atomicJson(gate.statePath, { phase: 'verified' });
  await expect(gate.activity(async () => undefined)).rejects.toThrow('Restore in progress');
  await vi.waitFor(async () => { expect(await readdir(gate.activityDirectory)).toEqual([]); });
});

it('logs a persistent journal read failure once per kind and keeps its durable lease', async () => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const original = files.readJson, lines: string[] = [];
  let attempts = 0;
  vi.spyOn(files, 'readJson').mockImplementation(async path => {
    if (path === gate.statePath) { attempts++; throw Object.assign(new Error('Private path'), { code: 'EIO' }); }
    return original(path);
  });
  const sink = setLogSink(line => { lines.push(line); });
  try {
    await files.atomicJson(gate.statePath, { phase: 'complete' });
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(3); }, { timeout: 2_000 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'restore.activity_monitor_failed', pid: process.pid,
      operation: 'journal', error: { code: 'EIO' } });
    expect(lines[0]).not.toContain('Private path');
    expect(await readdir(gate.activityDirectory)).toHaveLength(1);
  } finally { setLogSink(sink); }
});

it('logs a persistent lease-removal error once and retries without abandoning the lease', async () => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const [name] = await readdir(gate.activityDirectory), lease = join(gate.activityDirectory, name!);
  const original = fs.rm, lines: string[] = [];
  let attempts = 0;
  vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
    if (path === lease) { attempts++; throw Object.assign(new Error('Private path'), { code: 'EACCES' }); }
    return original(path, options);
  });
  const sink = setLogSink(line => { lines.push(line); });
  try {
    await files.atomicJson(gate.statePath, { phase: 'verified' });
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(3); }, { timeout: 2_000 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'restore.activity_monitor_failed', operation: 'lease', error: { code: 'EACCES' } });
    expect(await files.exists(lease)).toBe(true);
    await expect(gate.activity(async () => undefined)).rejects.toThrow('Restore in progress');
  } finally { setLogSink(sink); }
});

it.each(['journal', 'lease'])('logs a flapping %s failure once per episode', async operation => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const lines: string[] = [];
  let attempts = 0, now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fail = () => { if (++attempts % 2) throw Object.assign(new Error('Private path'), { code: 'EIO' }); };
  if (operation === 'journal') {
    const original = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
      if (path === gate.statePath) fail();
      return original(path, options);
    });
  } else {
    const original = files.exists;
    vi.spyOn(files, 'exists').mockImplementation(async path => {
      if (path === gate.activityDirectory) fail();
      return original(path);
    });
  }
  const sink = setLogSink(line => { lines.push(line); });
  try {
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(8); }, { timeout: 2_000 });
    expect(lines).toHaveLength(1);
    // Even a success near the quiet-time boundary must not reopen a flapping error's log.
    now = 4_999;
    const before = attempts;
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(before + 4); }, { timeout: 2_000 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'restore.activity_monitor_failed', operation, error: { code: 'EIO' } });
    expect(lines[0]).not.toContain('Private path');
  } finally { setLogSink(sink); }
});

it('logs a journal failure again only after five seconds without that failure', async () => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const original = fs.stat, lines: string[] = [];
  let failing = true, attempts = 0, now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
    if (path === gate.statePath) { attempts++; if (failing) throw Object.assign(new Error('Denied'), { code: 'EIO' }); }
    return original(path, options);
  });
  const sink = setLogSink(line => { lines.push(line); });
  try {
    await vi.waitFor(() => { expect(lines).toHaveLength(1); });
    failing = false; now = 5_000;
    const before = attempts;
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(before + 2); });
    failing = true;
    await vi.waitFor(() => { expect(lines).toHaveLength(2); });
  } finally { setLogSink(sink); }
});

it('logs a failure that returns after five seconds without one, though no successful tick came between', async () => {
  const gate = await fixture();
  await gate.activity(async () => undefined);
  const original = fs.stat, lines: string[] = [];
  let attempts = 0, now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
    if (path === gate.statePath) { attempts++; throw Object.assign(new Error('Denied'), { code: 'EIO' }); }
    return original(path, options);
  });
  const sink = setLogSink(line => { lines.push(line); });
  try {
    await vi.waitFor(() => { expect(lines).toHaveLength(1); });
    // Stands for a monitor that stopped checking (busy or retired) and meets the failure again much later.
    now = 60 * 60_000;
    await vi.waitFor(() => { expect(lines).toHaveLength(2); });
    const before = attempts;
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(before + 3); });
    expect(lines).toHaveLength(2);
  } finally { setLogSink(sink); }
});

it('resets the drain timeout as admitted local work leaves', async () => {
  const gate = await fixture();
  const releases: (() => void)[] = [];
  const active = [0, 1].map(index => gate.activity(() => new Promise<void>(resolve => { releases[index] = resolve; })));
  await vi.waitFor(() => { expect(releases.filter(Boolean)).toHaveLength(2); });
  vi.useFakeTimers();
  let finished = false;
  const closing = gate.close().then(() => { finished = true; });
  try {
    await vi.advanceTimersByTimeAsync(240_000);
    releases[0]!(); await active[0];
    await vi.advanceTimersByTimeAsync(240_000);
    expect(finished).toBe(false);
    releases[1]!(); await Promise.all(active);
    await closing;
    expect(finished).toBe(true);
  } finally { vi.useRealTimers(); for (const release of releases) release(); await Promise.all(active); await closing; }
});

it('resets the drain timeout when a waiting process leaves', async () => {
  const gate = await fixture(), firstPid = 123_456, secondPid = 234_567;
  const first = join(gate.activityDirectory, 'aaa.json'), second = join(gate.activityDirectory, 'bbb.json');
  const started = process.platform === 'linux' ? '0' : null;
  await files.atomicJson(first, { pid: firstPid, started });
  await files.atomicJson(second, { pid: secondPid, started });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const original = fs.readFile;
  vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
    if (path === '/proc/' + firstPid + '/stat' || path === '/proc/' + secondPid + '/stat')
      return '1 (worker) ' + Array<string>(20).fill('0').join(' ');
    return original(path, options);
  });
  const read = vi.spyOn(files, 'readJson');
  vi.useFakeTimers();
  let finished = false;
  const closing = gate.close().then(() => { finished = true; });
  try {
    await vi.waitFor(() => { expect(read.mock.calls.some(([path]) => path === second)).toBe(true); });
    await vi.advanceTimersByTimeAsync(240_000);
    await rm(first);
    const calls = read.mock.calls.filter(([path]) => path === second).length;
    await vi.waitFor(() => { expect(read.mock.calls.filter(([path]) => path === second).length).toBeGreaterThanOrEqual(calls + 2); });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(finished).toBe(false);
    await rm(second);
    await vi.waitFor(() => { expect(finished).toBe(true); });
    await closing;
  } finally {
    vi.useRealTimers(); await rm(first, { force: true }); await rm(second, { force: true }); await closing;
  }
});

it('times out a separate live process lease without deleting it or leaving a drain loop running', async () => {
  const gate = await fixture(), lease = join(gate.activityDirectory, 'abc.json');
  const stat = process.platform === 'linux' ? await readFile('/proc/' + process.pid + '/stat', 'utf8') : null;
  const started = stat === null ? null : stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
  await files.atomicJson(lease, { pid: process.pid, started });
  vi.useFakeTimers();
  const progress = vi.fn(), draining = new RestoreGate(gate.dataDirectory, { onDrainWait: progress });
  const reads = vi.spyOn(files, 'readJson');
  const closing = expect(draining.close()).rejects.toThrow('Timed out waiting for restore activity to drain');
  try {
    await vi.waitFor(() => { expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2); });
    await vi.advanceTimersByTimeAsync(300_000);
    await closing;
    expect(progress).toHaveBeenCalledWith(process.pid);
    expect(await files.exists(lease)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); await rm(lease, { force: true }); }
});

it('bounds a local drain without polling its in-memory count and keeps admission closed after timeout', async () => {
  const gate = await fixture();
  let release!: () => void, admitted!: () => void;
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const active = gate.activity(async () => { admitted(); await new Promise<void>(resolve => { release = resolve; }); });
  await entered;
  vi.useFakeTimers();
  const progress = vi.fn(), draining = new RestoreGate(gate.dataDirectory, { onDrainWait: progress });
  const closing = expect(draining.close()).rejects.toThrow('Timed out waiting for restore activity to drain');
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(progress).toHaveBeenCalledWith(process.pid);
    await vi.advanceTimersByTimeAsync(295_000);
    await closing;
    await expect(draining.activity(async () => undefined)).rejects.toThrow('Restore in progress');
  } finally { vi.useRealTimers(); release(); await active; }
});
