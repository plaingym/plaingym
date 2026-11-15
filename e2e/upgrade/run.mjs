// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gates, history, currentJournal, checkChain, contractExceptions, contractRemovals, fingerprintSql, remainingColumnsSql, digest, ident, quote, root, migrationPath } from './history.mjs';
import { fixture } from './fixture.mjs';
import { readPages } from './browser.mjs';

const image = process.argv[2];
assert.ok(image, 'Usage: node e2e/upgrade/run.mjs IMAGE');
const loopback = process.env.E2E_LOOPBACK ?? '127.0.0.1';
assert.match(loopback, /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
const output = resolve(root, 'e2e/coverage/upgrade');
// A failed earlier run's logs and screenshots must not sit beside this run's report.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'plaingym-upgrade-'));
const token = () => randomBytes(32).toString('hex');
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim(), snapshots: [], cleanup: [] };
const command = (binary, args, options = {}) => execFileSync(binary, args, {
  cwd: root, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options,
});
try {
  report.expandOnlyMigrations = checkChain();
  // A real copy of the chain, never the checkout: append a destructive migration and require the same checker to fail.
  const scratch = join(temporary, 'migrations');
  cpSync(join(root, migrationPath), scratch, { recursive: true });
  const journal = currentJournal(), last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: '9999_destructive_probe' });
  writeFileSync(join(scratch, 'meta/_journal.json'), JSON.stringify(journal));
  const probeSql = 'ALTER TABLE "members" DROP COLUMN "first_name";\n';
  writeFileSync(join(scratch, '9999_destructive_probe.sql'), probeSql);
  assert.throws(() => checkChain(pathToFileURL(scratch + '/')), /non-expand migration/);
  report.destructiveProbe = 'members.first_name drop rejected in scratch copy';
  const probeExceptions = { ...contractExceptions, '9999_destructive_probe': { sha256: digest(probeSql), reason: 'Disposable contract probe only.',
    removedColumns: [{ table: 'members', column: 'first_name' }] } };
  checkChain(pathToFileURL(scratch + '/'), probeExceptions);
  const probeRemovals = contractRemovals(journal.entries.slice(-1), probeExceptions);
  for (const gate of gates) {
    const started = Date.now();
    const project = `plaingym-upgrade-${gate.gate.toLowerCase()}-${randomUUID()}`;
    const env = { ...process.env, COMPOSE_PROJECT_NAME: project, APP_IMAGE: image,
      // Keep the browser's Origin equal to the production single-gym origin (HTTPS, port 443).
      GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org', HTTP_PORT: `${loopback}:80`, HTTPS_PORT: `${loopback}:443`,
      POSTGRES_DB: 'plaingym', POSTGRES_PASSWORD: token(), APP_PASSWORD: token(), MAINTENANCE_PASSWORD: token(),
      APP_ENCRYPTION_KEY: token(), AUTH_SECRET: token(), SETUP_TOKEN: token(), UPDATE_CHECK: 'off', AUTH_PASSWORD_LOGIN: 'on',
      // As in the End-to-end stack: repeated page walks must not consume the ordinary visitor budget.
      RATE_LIMIT_PER_MINUTE: '20000' };
    const envFile = join(temporary, `${gate.gate}.env`);
    writeFileSync(envFile, '', { mode: 0o600 });
    const prefix = ['compose', '--project-directory', join(root, 'deploy'), '--env-file', envFile, '-p', project, '-f', join(root, 'deploy/compose.yaml')];
    const docker = (args, options = {}) => command('docker', args, { env, ...options });
    const compose = (args, options) => docker([...prefix, ...args], options);
    const sql = query => compose(['exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'plaingym', '-v', 'ON_ERROR_STOP=1', '-qtA'], { input: query });
    let cleanupFailed = false;
    const down = () => {
      if (cleanupFailed) return; // A timed-out removal is reported, never retried.
      try { compose(['down', '--volumes', '--remove-orphans'], { timeout: 120_000 }); }
      catch (error) { cleanupFailed = true; report.cleanup.push(`${project}: ${error.message}`); throw error; }
    };
    try {
      const { migrations, tables } = history(gate);
      const seed = fixture(tables, env.APP_ENCRYPTION_KEY);
      const rewrittenColumns = new Set(seed.secrets.filter(secret => secret.version === 'v1').map(secret => secret.column));
      const readGym = () => JSON.parse(sql(`SELECT row_to_json(g) FROM gyms g WHERE id=${quote(seed.ids.gyms)};`));
      const verifySecrets = afterMigration => {
        const row = readGym(), secretsFile = join(temporary, `${gate.gate}-secrets.json`);
        const secrets = seed.secrets.map(secret => ({ ...secret, storedVersion: afterMigration ? 'v2' : secret.version }));
        writeFileSync(secretsFile, JSON.stringify({ key: env.APP_ENCRYPTION_KEY, secrets, row }), { mode: 0o600 });
        command(process.execPath, ['--import', pathToFileURL(join(root, 'apps/server/node_modules/tsx/dist/loader.mjs')).href, 'e2e/upgrade/read-settings.mjs', secretsFile], { stdio: 'inherit' });
        return row;
      };
      compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
      // One psql session keeps this probe in a temporary table, outside the gate dataset.
      // Exercise the reviewed chain entry and actual SQL used for both fingerprint stages.
      const probeTables = [{ name: 'members', columns: { id: {}, first_name: {}, label: {} } }];
      const fullProbe = fingerprintSql(probeTables), retainedProbe = fingerprintSql(probeTables, new Set(), probeRemovals);
      const remainingProbe = remainingColumnsSql(probeRemovals);
      const probeRows = sql(`CREATE TEMP TABLE members(id integer, first_name text, label text);
        INSERT INTO members VALUES (1, 'Retired', 'Kept'), (2, 'Old', 'Also kept');
        ${fullProbe}
        ${retainedProbe}
        UPDATE members SET first_name='Changed' WHERE id=1;
        ${fullProbe}
        ${retainedProbe}
        ${remainingProbe}
        ${probeSql}
        ${remainingProbe}
        ${retainedProbe}
        UPDATE members SET label='Changed' WHERE id=1;
        ${retainedProbe}
        DELETE FROM members WHERE id=2;
        ${retainedProbe}`).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(probeRows.length, 9, 'contract probe fingerprint count');
      assert.notDeepEqual(probeRows[0], probeRows[2], 'removed column is checksummed before migration');
      assert.deepEqual(probeRows[1], probeRows[3], 'comparable fingerprint leaves out only the listed column');
      assert.deepEqual(probeRows[4], ['members.first_name'], 'listed column is reported while it exists');
      assert.deepEqual(probeRows[5], [], 'listed column is gone after the contract step');
      assert.deepEqual(probeRows[3], probeRows[6], 'listed column removal preserves retained data');
      assert.notDeepEqual(probeRows[6], probeRows[7], 'retained column mutation still fails');
      assert.equal(probeRows[8][1].rows, 1, 'row removal stays visible');
      sql('SET ROLE maintenance; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);');
      for (const migration of migrations) {
        sql(`BEGIN; SET LOCAL ROLE maintenance;\n${migration.sql}\nINSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (${quote(migration.hash)},${migration.when}); COMMIT;`);
      }
      sql('SET ROLE maintenance;\n' + tables.map(table => `ALTER TABLE ${ident(table.name)} FORCE ROW LEVEL SECURITY;`).join('\n'));
      // This is fixture construction only; SQL constraints and FK checks stay enabled throughout.
      sql(seed.sql);
      const catalog = JSON.parse(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';"));
      assert.deepEqual(catalog, tables.map(table => table.name).sort(), `${gate.gate}: every historical table is inventoried`);
      // Secret plaintext/version are checked separately; contract exclusions apply only to
      // migrations after this gate. Dump/restore still checks every original column.
      const removals = contractRemovals(currentJournal().entries.slice(gate.count));
      const fingerprint = (excluded = []) => Object.fromEntries(sql(fingerprintSql(tables, rewrittenColumns, excluded))
        .trim().split('\n').map(line => JSON.parse(line)));
      const before = fingerprint();
      const upgradeBefore = removals.length ? fingerprint(removals) : before;
      for (const [table, value] of Object.entries(before)) assert.ok(value.rows > 0, `${table} must not be empty`);
      const dump = compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', 'plaingym', '-Fc', '--no-owner'], { encoding: 'buffer' });
      assert.ok(dump.length < 3 * 1024 * 1024, 'gate dump must stay below 3 MiB');
      writeFileSync(join(temporary, `${gate.gate}.dump`), dump, { mode: 0o600 });
      // Tear down the source cluster, including its volume. The restore gets a genuinely fresh Postgres.
      down();
      compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
      // PostgreSQL's dump omits CREATE SCHEMA for its built-in public schema. Bootstrap supplied it empty.
      compose(['exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', 'plaingym', '--no-owner', '--role=maintenance', '--exit-on-error', '--single-transaction'], { input: dump });
      assert.deepEqual(fingerprint(), before, `${gate.gate}: dump/restore preserves all rows`);
      verifySecrets(false);
      compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', '/app/deploy/database.sh', 'app', 'migrate']);
      assert.deepEqual(JSON.parse(sql(remainingColumnsSql(removals))), [], `${gate.gate}: every listed contract removal dropped its column`);
      assert.deepEqual(fingerprint(removals), upgradeBefore, `${gate.gate}: all retained historical columns and counts survive the upgrade`);
      const upgradedGym = verifySecrets(true);
      const applied = JSON.parse(sql('SELECT json_agg(json_build_object(\'hash\',hash,\'when\',created_at) ORDER BY id) FROM drizzle.__drizzle_migrations;'));
      const expected = currentJournal().entries.map(entry => ({ hash: digest(readFileSync(join(root, migrationPath, entry.tag + '.sql'))), when: entry.when }));
      assert.deepEqual(applied, expected, `${gate.gate}: complete ordered migration journal`);
      // A second migration must be a no-op, including historical data.
      compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', '/app/deploy/database.sh', 'app', 'migrate']);
      assert.deepEqual(fingerprint(removals), upgradeBefore, `${gate.gate}: migrate is idempotent`);
      const repeatedGym = verifySecrets(true);
      for (const secret of seed.secrets) {
        assert.equal(repeatedGym[secret.column], upgradedGym[secret.column], `second migration does not rewrite ${secret.column}`);
      }
      compose(['up', '-d', '--wait', '--wait-timeout', '120']);
      const port = Number(compose(['port', 'caddy', '443']).trim().split(':').at(-1));
      const browser = await readPages({ loopback, port, ids: seed.ids, password: seed.password, signatureHash: seed.signatureHash, output, gate: gate.gate });
      const result = { ...gate, project, tables: tables.length, dumpBytes: dump.length, dumpSha256: digest(dump), fingerprints: before,
        upgradeFingerprints: upgradeBefore, contractExclusions: removals,
        contractProbe: 'reviewed column drop accepted; retained-column mutation and row removal detected',
        secrets: seed.secrets.map(({ column, version }) => ({ column, before: version, after: 'v2', plaintextPreserved: true, secondMigrationUnchanged: true })),
        checksumExclusions: [...rewrittenColumns].map(column => `gyms.${column}: separately verified plaintext and envelope upgrade`),
        browser, seconds: Math.round((Date.now() - started) / 1000) };
      report.snapshots.push(result);
      console.log(`PASS ${gate.gate} v${gate.version}: ${tables.length} tables, ${dump.length} dump bytes, ${result.seconds}s`);
    } catch (error) {
      try { writeFileSync(join(output, `${gate.gate}-containers.log`), compose(['logs', '--no-color', '--tail', '60'])); }
      catch { /* Keep the original failure. */ }
      throw error;
    } finally {
      try { down(); } catch { /* The failure was recorded; still inventory anything left, without retrying removal. */ }
      for (const args of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
        try {
          const leftovers = docker([...args, '--filter', `label=com.docker.compose.project=${project}`], { timeout: 30_000 }).trim();
          if (leftovers) report.cleanup.push(`${project}: ${args[0]} left ${leftovers}`);
        } catch (error) { report.cleanup.push(`${project}: could not inventory ${args[0]}: ${error.message}`); }
      }
    }
  }
  assert.deepEqual(report.cleanup, [], 'all owned resources removed');
} catch (error) {
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  rmSync(temporary, { recursive: true, force: true });
}
