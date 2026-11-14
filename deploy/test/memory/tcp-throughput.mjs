// SPDX-License-Identifier: AGPL-3.0-only
// Linux CI acceptance: the shipped Caddy TCP buffer limits, with 100 ms round-trip latency.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deploy = fileURLToPath(new URL('../../', import.meta.url));
const nodeImage = 'node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const prefix = 'plaingym-tcp-' + randomUUID(), server = prefix + '-caddy', client = prefix + '-client';
const temporary = mkdtempSync(join(tmpdir(), prefix));
const hostSetting = readFileSync('/proc/sys/net/ipv4/tcp_wmem', 'utf8');
const hostReceiveSetting = readFileSync('/proc/sys/net/ipv4/tcp_rmem', 'utf8');
const command = (binary, args, options = {}) => execFileSync(binary, args,
  { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, ...options }).trim();
const docker = (args, options) => command('docker', args, options);
const env = { ...process.env, APP_IMAGE: nodeImage, GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.invalid',
  POSTGRES_PASSWORD: 'fixture', APP_PASSWORD: 'fixture', MAINTENANCE_PASSWORD: 'fixture',
  APP_ENCRYPTION_KEY: 'fixture', AUTH_SECRET: 'fixture', SETUP_TOKEN: 'fixture' };
// The rendered default, not a caller's override, is what installs get.
delete env.CADDY_MEMORY_LIMIT;
let network = false;
const containers = [], cleanupFailures = [];
try {
  writeFileSync(join(temporary, '.env'), '');
  writeFileSync(join(temporary, 'download.bin'), Buffer.alloc(32 * 1024 ** 2, 1));
  const { caddy } = JSON.parse(docker(['compose', '--env-file', join(temporary, '.env'),
    '-f', join(deploy, 'compose.yaml'), 'config', '--format', 'json'], { env })).services;
  assert.equal(caddy.sysctls['net.ipv4.tcp_wmem'], '4096 16384 524288');
  assert.equal(caddy.sysctls['net.ipv4.tcp_rmem'], '4096 131072 524288');
  assert.equal(Number(caddy.mem_limit), 128 * 1024 ** 2);
  docker(['network', 'create', prefix]); network = true;
  const common = ['--network', prefix, '--label', 'plaingym.tcp-probe=' + prefix, '--cpus', '0.5',
    '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1'];
  // Registered before `docker run`: a container created but not started still needs removing.
  containers.push(server);
  docker(['run', '-d', '--name', server, ...common, '--memory', String(caddy.mem_limit),
    ...Object.entries(caddy.sysctls).flatMap(([key, value]) => ['--sysctl', key + '=' + value]),
    '-v', `${temporary}:/srv:ro`, '--entrypoint', 'nice', caddy.image,
    '-n', '10', 'timeout', '180', 'caddy', 'file-server', '--listen', ':8080', '--root', '/srv']);
  containers.push(client);
  docker(['run', '-d', '--name', client, ...common, '--memory', '128m', nodeImage, 'nice', '-n', '10', 'timeout', '180', 'sleep', '180']);
  const readSetting = name => docker(['exec', name, 'cat', '/proc/sys/net/ipv4/tcp_wmem']).replace(/\s+/g, ' ');
  assert.equal(readSetting(server), caddy.sysctls['net.ipv4.tcp_wmem']);
  assert.equal(docker(['exec', server, 'cat', '/proc/sys/net/ipv4/tcp_rmem']).replace(/\s+/g, ' '), caddy.sysctls['net.ipv4.tcp_rmem']);
  assert.equal(readFileSync('/proc/sys/net/ipv4/tcp_wmem', 'utf8'), hostSetting, 'the host setting is unchanged');
  assert.equal(readFileSync('/proc/sys/net/ipv4/tcp_rmem', 'utf8'), hostReceiveSetting, 'the host receive setting is unchanged');
  for (const name of containers) {
    const pid = docker(['inspect', '--format', '{{.State.Pid}}', name]);
    // Use the runner's tc binary in each isolated network namespace; no host interface is changed.
    command('sudo', ['-n', 'nsenter', '-t', pid, '-n', 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', 'delay', '50ms']);
  }
  const probe = `
    const { setTimeout: sleep } = await import('node:timers/promises');
    const base = 'http://${server}:8080';
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(base + '/download.bin', { method: 'HEAD', signal: AbortSignal.timeout(2000) }); if (r.ok) { ready = true; break; } }
      catch { /* bounded startup wait */ }
      await sleep(100);
    }
    if (!ready) throw new Error('Caddy did not become ready');
    const started = performance.now();
    const response = await fetch(base + '/download.bin', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Download status ' + response.status);
    let bytes = 0;
    for await (const chunk of response.body) bytes += chunk.length;
    const seconds = (performance.now() - started) / 1000;
    console.log(JSON.stringify({ bytes, seconds, megabytesPerSecond: bytes / seconds / 1e6, roundTripMs: 100 }));
  `;
  const result = JSON.parse(docker(['exec', client, 'nice', '-n', '10', 'timeout', '45', 'node', '--input-type=module', '-e', probe]));
  console.log('Caddy TCP throughput: ' + JSON.stringify({ ...result, sysctls: caddy.sysctls }));
  assert.equal(result.bytes, 32 * 1024 ** 2);
  assert.ok(result.megabytesPerSecond >= 3, 'one download must sustain at least 3 MB/s at 100 ms RTT');
} finally {
  for (const name of containers) {
    try { docker(['rm', '-f', '-v', name], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      // A name registered for a `docker run` that never created it is already gone.
      if (!/No such container/i.test(String(error.stderr ?? '') + error.message)) cleanupFailures.push(name + ': ' + error.message);
    }
  }
  if (network) {
    try { docker(['network', 'rm', prefix]); }
    catch (error) { cleanupFailures.push(prefix + ': ' + error.message); }
  }
  rmSync(temporary, { recursive: true, force: true });
  if (cleanupFailures.length) console.error('TCP probe cleanup failures: ' + cleanupFailures.join('; '));
}
assert.deepEqual(cleanupFailures, [], 'all TCP probe resources must be removed');
