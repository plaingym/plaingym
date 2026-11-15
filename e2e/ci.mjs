// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

// Only the default suite: VM and UX captures have their own opt-in runs and setup paths.
export function changedSpecs(names) {
  return names.filter(name => /^e2e\/(specs|multi)\/.+\.spec\.ts$/.test(name)
    && !/\/(vm|ux-pass)\.spec\.ts$/.test(name));
}

export function fileFilters(files) {
  if (!files.length || changedSpecs(files).length !== files.length) throw new Error('Expected default-suite spec files');
  // Playwright's positional file arguments are regular expressions, not literal paths.
  return files.map(file => '(^|/)' + file.slice('e2e/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
}

export function reportTests(report) {
  if (report.errors?.length) throw new Error('Playwright could not collect the suite: ' + JSON.stringify(report.errors));
  const tests = [];
  const visit = suite => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) tests.push(`${test.projectName}:${spec.id}`);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  return tests;
}

export function verifyShards(single, shards) {
  const expected = new Set(single), actual = shards.flat(), unique = new Set(actual);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = single.filter(id => !unique.has(id)), extra = actual.filter(id => !expected.has(id));
  if (!single.length || expected.size !== single.length || duplicates.length || missing.length || extra.length) {
    throw new Error(`Suite mismatch: ${JSON.stringify({ duplicates, missing, extra, single: single.length, actual: actual.length })}`);
  }
  return { single: single.length, shards: shards.map(tests => tests.length), total: actual.length };
}

export function shardFiles(report) {
  reportTests(report); // Reject collection errors before writing a partial selection.
  const files = new Map();
  const visit = (suite, ownerFile = suite.file) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      // A helper can declare a test for a spec wrapper: its declaration location is
      // not the discoverable spec file. Keep the top-level suite's owning filename.
      const file = (ownerFile ?? spec.file).replaceAll('\\', '/');
      if (!files.has(file)) files.set(file, new Set());
      files.get(file).add(`[${test.projectName}] > ${file}`);
    }
    for (const child of suite.suites ?? []) visit(child, ownerFile ?? child.file);
  };
  for (const suite of report.suites) visit(suite);
  const shards = [[], [], [], []];
  const wizard = [...files].filter(([, lines]) => [...lines].some(line => line.startsWith('[fresh-setup]')));
  if (wizard.length !== 1) throw new Error('Expected exactly one wizard file');
  shards[0].push(...wizard[0][1]);
  // Balance by whole files, not test counts: the many small tests in one file must not
  // push every one-test isolation slice onto the last shard. Keep nested describes together.
  [...files.keys()].filter(file => file !== wizard[0][0]).sort().forEach((file, index) => {
    shards[index % shards.length].push(...files.get(file));
  });
  return shards;
}

function collect(args = []) {
  // Collection only; this never starts browsers or needs the Compose stack's credentials.
  const output = execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json', ...args],
    { cwd: directory, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(output);
}

function writeShardLists(report) {
  mkdirSync(resolve(directory, 'coverage'), { recursive: true });
  return shardFiles(report).map((lines, index) => {
    const path = resolve(directory, `coverage/shard-${index + 1}.txt`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  });
}

function main(command) {
  if (command === 'changed-specs') {
    const names = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', '-z', 'origin/main...HEAD', '--', 'e2e/'],
      { cwd: resolve(directory, '..'), encoding: 'utf8', timeout: 30_000 }).split('\0').filter(Boolean);
    const files = changedSpecs(names);
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${files.length > 0}\nfiles=${JSON.stringify(files)}\n`);
    console.log(`Changed specs against the main merge base: ${JSON.stringify(files)}`);
  } else if (command === 'run-changed') {
    const filters = fileFilters(JSON.parse(process.env.E2E_CHANGED_SPECS ?? '[]'));
    // The fixture initializes setup through the API; do not add unrelated dependency specs.
    execFileSync(process.execPath, ['run.mjs', '--no-deps', ...filters], { cwd: directory, stdio: 'inherit', timeout: 18 * 60_000 });
  } else if (command === 'shard-lists') {
    const paths = writeShardLists(collect());
    console.log(`Wrote ${paths.length} whole-file shard selections`);
  } else if (command === 'inventory') {
    const report = collect(), single = reportTests(report);
    const shards = writeShardLists(report).map(path => reportTests(collect(['--test-list', path, '--no-deps'])));
    const counts = verifyShards(single, shards);
    // Configuration order and one worker keep the only real wizard ahead of its shard's other specs.
    if (!shards[0][0]?.startsWith('fresh-setup:') || shards.flat().filter(id => id.startsWith('fresh-setup:')).length !== 1) {
      throw new Error('The wizard must run exactly once, first on shard 1');
    }
    mkdirSync(resolve(directory, 'coverage'), { recursive: true });
    writeFileSync(resolve(directory, 'coverage/inventory.json'), JSON.stringify({ ...counts, tests: single }, null, 2) + '\n');
    console.log(`Single-stack / shard inventory: ${JSON.stringify(counts)}`);
  } else if (command === 'verify-report') {
    const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage/shards/e2e-shard-1/inventory.json'), 'utf8'));
    const report = JSON.parse(readFileSync(resolve(directory, 'coverage/results.json'), 'utf8'));
    const counts = verifyShards(inventory.tests, [reportTests(report)]);
    console.log(`Merged report matches single-stack inventory: ${counts.total} tests; ${JSON.stringify(report.stats)}`);
  } else {
    throw new Error('Expected changed-specs, run-changed, shard-lists, inventory or verify-report');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);
