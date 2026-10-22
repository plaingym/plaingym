// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicJson } from './backups.files.js';
import { RestoreGate } from './restore.gate.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
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
