// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const file of ['demo/test-local.sh', 'test/rollback.sh']) {
  test(`${file} continues cleanup after each removal times out`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'bounded-cleanup-'));
    try {
      const temporary = join(directory, 'temporary'), install = join(temporary, 'install');
      mkdirSync(install, { recursive: true });
      writeFileSync(join(install, '.env'), '');
      writeFileSync(join(install, 'lib.sh'), 'compose() { :; }\n');
      const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
      const cleanup = source.slice(source.indexOf('cleanup() {'), source.indexOf('\ntrap cleanup EXIT'));
      assert.ok(cleanup.startsWith('cleanup() {'));
      const script = join(directory, 'cleanup.sh'), log = join(directory, 'calls');
      writeFileSync(script, `set -eu
timeout() { printf '%s\\n' "$*" >> "$LOG"; return 124; }
${cleanup}
cleanup
`);
      execFileSync('sh', [script], { timeout: 10_000, env: { ...process.env, LOG: log, ROOT: install, temporary,
        COMPOSE_PROJECT_NAME: 'fixture-project', s3_name: 'fixture-s3', test_id: 'fixture-id',
        run_id: 'fixture-run', registry_name: 'fixture-registry', oldest_id: 'fixture-oldest', old_id: 'fixture-old', new_id: 'fixture-new' }, stdio: 'pipe' });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(calls.length, file.startsWith('demo/') ? 8 : 5);
      assert.ok(calls.every(call => call.startsWith('-k 5 120 docker ')), calls.join('\n'));
      assert.ok(calls.some(call => call.includes('down --volumes --remove-orphans')));
      assert.ok(calls.at(-1).includes(file.startsWith('demo/') ? 'refresh-fixture-id' : 'fixture-new'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
