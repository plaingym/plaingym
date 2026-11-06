// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './host.ts';
import { summarizeMemory } from './memory-summary.ts';
import { execFileSync } from 'node:child_process';

const coverage = fileURLToPath(new URL('../coverage/', import.meta.url));
await mkdir(coverage, { recursive: true });
const directory = await mkdtemp(resolve(coverage, 'config-test-'));
await writeFile(resolve(directory, 'bundle.tar'), 'fixture');
const base = () => ({ source: { url: 'https://gym.example.org', fresh: true, ssh: { host: '192.0.2.10', user: 'root' } },
  restore: { url: 'https://gym.example.org', fresh: true, ssh: { host: '192.0.2.11', user: 'root' } },
  bundle: { file: 'bundle.tar', url: 'https://storage.example.org/bundle.tar', bootstrapUrl: 'https://storage.example.org/bootstrap.sh' },
  artifacts: 'results', email: 'qa@example.org',
  s3: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'qa', accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
async function load(value) {
  const file = resolve(directory, 'config.json');
  await writeFile(file, JSON.stringify(value));
  const previous = process.env.E2E_VM_CONFIG;
  process.env.E2E_VM_CONFIG = file;
  try { return await configuration(); }
  finally { if (previous === undefined) delete process.env.E2E_VM_CONFIG; else process.env.E2E_VM_CONFIG = previous; }
}
test('resolves private bundle and artifact paths from the config, independent of cwd', async () => {
  const config = await load(base());
  assert.equal(config.bundle.file, resolve(directory, 'bundle.tar'));
  assert.equal(config.artifacts, resolve(directory, 'results'));
});
test('refuses an ambiguous or already-used target before any SSH operation', async () => {
  const config = base();
  config.source.fresh = false;
  await assert.rejects(load(config), /fresh:true/);
  config.source.fresh = true;
  config.restore.ssh.host = config.source.ssh.host;
  await assert.rejects(load(config), /second fresh host/);
});
test('refuses SSH option injection and an invalid SSH port', async () => {
  const config = base();
  config.source.ssh.host = '-oProxyCommand=touch-marker';
  await assert.rejects(load(config), /valid SSH host/);
  config.source.ssh.host = '192.0.2.10';
  config.source.ssh.port = 65536;
  await assert.rejects(load(config), /Invalid SSH port/);
});
test('cannot disable public certificate verification with a local-fixture flag', async () => {
  const config = { ...base(), localFixture: true };
  await assert.rejects(load(config), /loopback/);
});
test('cannot remap a remote connection port using a fixture-only option', async () => {
  const config = base();
  config.source.connectPort = 9443;
  await assert.rejects(load(config), /local-only/);
  await assert.rejects(load({...base(),localSnapshotRetry:true}), /local-only/);
});
test('a remote install runs the operator command from HTTPS bundle URLs', async () => {
  await assert.rejects(load({ ...base(), bundle: { file: 'bundle.tar' } }), /operator command/);
  await assert.rejects(load({ ...base(), bundle: { ...base().bundle, url: 'http://storage.example.org/bundle.tar' } }), /HTTPS/);
  await assert.rejects(load({ ...base(), bundle: { ...base().bundle, bootstrapUrl: "https://x.example.org/a'; touch marker" } }), /HTTPS/);
});
test('rejects different restore hostnames rather than silently testing a broken login origin', async () => {
  const config = base();
  config.restore.url = 'https://different.example.org';
  await assert.rejects(load(config), /retains the gym hostname/);
});

const MiB = 1024 ** 2;
function memorySample(at, anon = 64, file = 62, current = anon + file) {
  return { at, containers: Object.fromEntries(['app', 'postgres', 'caddy'].map((name) => [name,
    { anon: anon * MiB, file: file * MiB, current: current * MiB, peak: current * MiB }])) };
}

test('VM idle budget uses anon while retaining totals and file cache beside it', () => {
  const summary = summarizeMemory([memorySample(80, 200), memorySample(90), memorySample(99), memorySample(100, 150)], 100);
  assert.equal(summary.idleStackBytes, 192 * MiB);
  assert.equal(summary.idleStackCurrentBytes, 378 * MiB);
  assert.equal(summary.idleStackFileBytes, 186 * MiB);
  assert.equal(summary.idleMetric, 'memory.stat anon');
  assert.ok(!summary.violations.some((line) => line.includes('idle')));
  assert.equal(summary.sampledStackPeakBytes, 786 * MiB);
  assert.equal(summary.containerPeakBytes.app, 262 * MiB);
});

test('VM idle anon above 250 MiB fails; a missing idle window has null figures and fails a measured run', () => {
  const samples = [memorySample(99, 84, 0, 84)];
  assert.ok(summarizeMemory(samples, 100).violations.some((line) => line.includes('idle anonymous memory')));
  assert.deepEqual(summarizeMemory([memorySample(99, 250 / 3, 0)], 100).violations, []);
  for (const busyStart of [undefined, 50]) {
    const summary = summarizeMemory(samples, busyStart);
    assert.equal(summary.idleStackBytes, null);
    assert.equal(summary.idleStackCurrentBytes, null);
    assert.equal(summary.idleStackFileBytes, null);
  }
  assert.deepEqual(summarizeMemory(samples).violations, []);
  assert.ok(summarizeMemory(samples, 50).violations.some((line) => line.includes('idle target was not measured')));
});

test('the VM Python sampler reads anon and file from memory.stat alongside existing counters', () => {
  const script = [
    'import json, memory',
    'from types import SimpleNamespace',
    'values = {"memory.stat": "anon 123\\nfile 456\\nkernel 789", "memory.current": "1000", "memory.peak": "2000", "memory.max": "536870912", "memory.swap.current": "0", "memory.events": "oom 0\\noom_kill 0"}',
    'group = SimpleNamespace(joinpath=lambda name: SimpleNamespace(read_text=lambda: values[name]))',
    'print(json.dumps(memory.sample_container(group, 2)))',
  ].join('\n');
  const sample = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script],
    { cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  assert.equal(sample.anon, 123);
  assert.equal(sample.file, 456);
  assert.equal(sample.current, 1000);
  assert.equal(sample.peak, 2000);
  assert.equal(sample.initialRestarts, 2);
  assert.deepEqual(sample.events, { oom: 0, oom_kill: 0 });
});
