// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDiagnostics, formatDiagnostics } from './diagnostics.mjs';

test('a forced OOM retains container state, kernel kill lines and logs before teardown', async () => {
  const out = await mkdtemp(join(tmpdir(), 'memory-diagnostics-'));
  try {
    const calls = [], since = '2026-11-14T00:00:00.000Z';
    const records = await collectDiagnostics({ compose: ['compose', '--project-name', 'forced-oom'], sampler: 'sampler', since, out }, async (binary, args, options) => {
      calls.push({ binary, args, options });
      const text = args.includes('inspect') ? '{"state":{"OOMKilled":true,"ExitCode":137},"restarts":1}'
        : args.includes('dmesg') ? 'oom-kill:constraint=CONSTRAINT_MEMCG\nMemory cgroup out of memory: Killed process 42 (caddy)\n'
          : args.includes('logs') ? 'last container log\n' : args.includes('ps') ? 'container-id\n' : 'oom event\n';
      return { code: 0, out: text, error: '' };
    });
    const printed = formatDiagnostics(records);
    assert.match(printed, /OOMKilled.*true.*ExitCode.*137/);
    assert.match(printed, /Killed process 42 \(caddy\)/);
    assert.match(printed, /app logs[\s\S]*last container log/);
    assert.match(printed, /caddy logs[\s\S]*last container log/);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'diagnostics.json'), 'utf8')), records);
    assert.ok(calls.every(({ options }) => options.cleanup && options.allowFailure && options.timeout === 15_000));
    const events = calls.find(({ args }) => args[0] === 'events').args;
    assert.ok(events.includes('--until'));
    assert.ok(events.includes(since));
    assert.equal(calls.find(({ binary }) => binary === 'sudo').args.at(-1), '@1794614400');
    assert.ok(calls.filter(({ args }) => args[0] === 'inspect').every(({ args }) => !args.join(' ').includes('Config.Env')));
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('unavailable diagnostics remain visible and do not hide the other evidence', async () => {
  const out = await mkdtemp(join(tmpdir(), 'memory-diagnostics-'));
  try {
    const records = await collectDiagnostics({ compose: ['compose', '--project-name', 'fixture'], sampler: 'sampler', since: '2026-11-14T00:00:00Z', out }, async (binary, args) => {
      if (binary === 'sudo') throw new Error('kernel permission denied');
      return { code: 1, out: '', error: args.includes('logs') ? 'container log unavailable' : 'daemon unavailable', timedOut: true };
    });
    const printed = formatDiagnostics(records);
    assert.match(printed, /kernel permission denied/);
    assert.match(printed, /container log unavailable/);
    assert.match(printed, /timed out/);
    assert.ok(records['container events']);
  } finally { await rm(out, { recursive: true, force: true }); }
});
