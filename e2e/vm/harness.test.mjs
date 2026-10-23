// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './host.ts';

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
