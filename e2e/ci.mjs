// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

// Only the default suite: VM and UX captures have their own opt-in runs and setup paths.
const defaultSpec = name => /^e2e\/(specs|multi)\/.+\.spec\.ts$/.test(name)
  && !/\/(vm|ux-pass)\.spec\.ts$/.test(name);

function suiteSources() {
  return new Map(['specs', 'multi'].flatMap(folder => readdirSync(resolve(directory, folder), { recursive: true })
    .filter(name => String(name).endsWith('.ts')).map(name => {
      const file = `e2e/${folder}/${String(name).replaceAll('\\', '/')}`;
      return [file, readFileSync(resolve(directory, '..', file), 'utf8')];
    })));
}

export function changedSpecs(names, sources = suiteSources()) {
  const affected = new Set(names.filter(name => /^e2e\/(specs|multi)\/.+\.ts$/.test(name)));
  // Follow relative imports and re-exports transitively, including a helper importing another helper.
  let grew;
  do {
    grew = false;
    for (const [file, source] of sources) {
      if (affected.has(file)) continue;
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)];
      if (imports.some(([, name]) => {
        if (!name.startsWith('.')) return false;
        const target = posix.normalize(posix.join(posix.dirname(file), name)).replace(/\.js$/, '.ts');
        return affected.has(target) || affected.has(target + '.ts');
      })) {
        affected.add(file);
        grew = true;
      }
    }
  } while (grew);
  return [...affected].filter(defaultSpec);
}

export function fileFilters(files) {
  if (!files.length || !files.every(defaultSpec)) throw new Error('Expected default-suite spec files');
  // Playwright's positional file arguments are regular expressions, not literal paths.
  return files.map(file => '(^|/)' + file.slice('e2e/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
}

export function reportTests(report, errorPrefix = 'Playwright could not collect the suite') {
  if (report.errors?.length) throw new Error(`${errorPrefix}: ${JSON.stringify(report.errors)}`);
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

export function shardNumbers(value = process.env.E2E_SHARD_COUNT ?? readFileSync(resolve(directory, '../.github/workflows/e2e.yml'), 'utf8')
  .match(/^ {2}E2E_SHARD_COUNT: ['"]?(\d+)/m)?.[1]) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('Expected E2E_SHARD_COUNT between 1 and 64');
  return Array.from({ length: count }, (_, index) => index + 1);
}

// Shared setup charged once per project per stack. Run 43987782721's blob reports show
// about 1s for single-gym initialization and about 11s to build both multi-gym fixtures.
const fixtureDurations = new Map([['members-mat', 1_000], ['multi-gym', 11_000]]);

// Milliseconds summed per file from End-to-end run 43987782721, with the first
// single-gym and multi-gym fixture setup costs subtracted where they ran, except
// where a line below names another run.
// Refresh from results.json and the shard blobs when the suite changes materially.
// New files use a conservative 20s estimate.
export const fileDurations = {
  'account-email.spec.ts': 4757, 'card-removal.spec.ts': 2688, 'customer-card-import.spec.ts': 6605,
  'demo-join.spec.ts': 56153, 'discount-screens.spec.ts': 27015, 'health-backups.spec.ts': 9251,
  'intake-retry.spec.ts': 1340, 'long-names.spec.ts': 25120,
  // End-to-end run 44655594877, shard 4: the spec's two tests, one passing first attempt each
  // (32250 + 1505 ms, no retries), with no shared setup inside them to subtract.
  'mobile-admin-phone.spec.ts': 33755,
  'mobile-public.spec.ts': 15874, 'portal-home.spec.ts': 3172, 'responsive.spec.ts': 1081,
  'settings-dashboard.spec.ts': 16057, 'sign-in-limits.spec.ts': 1037, 'website-branding.spec.ts': 2728,
  '../multi/bank-debit.spec.ts': 20000, '../multi/flows.spec.ts': 27486, '../multi/isolation-beta-alpha-1.spec.ts': 8135,
  'announcements.spec.ts': 17753, 'changed-fields-saves.spec.ts': 6748, 'demo-copy.spec.ts': 3574,
  'demo-landing.spec.ts': 24645, 'display-counts.spec.ts': 5564, 'household-isolation.spec.ts': 6263,
  'invoice-filter.spec.ts': 1812, 'mat-flow.spec.ts': 11503, 'mobile-kiosk-keyboard.spec.ts': 8701,
  'mobile.spec.ts': 15885, 'portal-polish.spec.ts': 10568, 'restore-payments.spec.ts': 5995,
  'settings-sign-in.spec.ts': 9908, 'sms-consent.spec.ts': 5134, 'website.spec.ts': 16095,
  '../multi/isolation-alpha-beta-1.spec.ts': 8729, '../multi/isolation-beta-alpha-2.spec.ts': 8781,
  'authorization.spec.ts': 51845, 'credit-messages.spec.ts': 2917, 'demo-discovery.spec.ts': 1879,
  'demo-links.spec.ts': 3211, 'downloads.spec.ts': 386, 'imports-catalog.spec.ts': 7289,
  'invoice-void.spec.ts': 2393, 'members-staff-screens.spec.ts': 5623, 'mobile-portal-keyboard.spec.ts': 11456,
  'pack-screens.spec.ts': 18245, 'portal-recovery.spec.ts': 3900, 'schedule-cancel-started.spec.ts': 3908,
  'settings-sms.spec.ts': 4696, 'sms-go-live.spec.ts': 5711, '../multi/isolation-alpha-beta-2.spec.ts': 8555,
  '../multi/isolation-beta-alpha-3.spec.ts': 6616, 'fresh-setup.spec.ts': 24919, 'booking-cutoff.spec.ts': 12838,
  'csp.spec.ts': 3025, 'demo-isolation.spec.ts': 5708, 'dialog-scroll.spec.ts': 2563, 'freeze-history.spec.ts': 4644,
  'imports-status.spec.ts': 7955, 'leads-leftovers.spec.ts': 8362, 'mobile-admin-desktop.spec.ts': 19057,
  'mobile-portal.spec.ts': 17834, 'pay-link-confirmation.spec.ts': 5033, 'price-change-screens.spec.ts': 10679,
  'send-generations.spec.ts': 4974, 'setup-kiosk-demo.spec.ts': 24360, 'waivers.spec.ts': 22643,
  '../multi/00-harness.spec.ts': 824, '../multi/isolation-alpha-beta-3.spec.ts': 8555, '../multi/isolation.spec.ts': 486,
};

// Place the bank debit spec after balancing the existing files so it doesn't move them between shards.
const filesPlacedLast = new Set(['../multi/bank-debit.spec.ts']);

export function shardFiles(report, count = shardNumbers().length, durations = fileDurations) {
  reportTests(report); // Reject collection errors before writing a partial selection.
  const files = new Map();
  const visit = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      const file = spec.file.replaceAll('\\', '/');
      if (!file.endsWith('.spec.ts')) throw new Error(`Test declared outside a spec file: ${file}`);
      if (!files.has(file)) files.set(file, new Set());
      files.get(file).add(test.projectName);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  const shards = shardNumbers(count).map(() => ({ lines: [], projects: new Set(), duration: 0 }));
  const duration = file => durations[file] ?? 20_000;
  const wizard = [...files].filter(([, projects]) => projects.has('fresh-setup'));
  if (wizard.length !== 1) throw new Error('Expected exactly one wizard file');
  const remaining = [...files].filter(([file]) => file !== wizard[0][0])
    .sort(([a], [b]) => Number(filesPlacedLast.has(a)) - Number(filesPlacedLast.has(b))
      || duration(b) - duration(a) || a.localeCompare(b));
  // Pin the wizard to stack 1, then place the largest files where they cost the least total time.
  for (const [file, projects] of [...wizard, ...remaining]) {
    const fileCost = duration(file);
    const totals = shards.map(shard => {
      let total = shard.duration + fileCost;
      for (const project of projects) {
        if (!shard.projects.has(project)) total += fixtureDurations.get(project) ?? 0;
      }
      return total;
    });
    const index = projects.has('fresh-setup') ? 0 : totals.indexOf(Math.min(...totals));
    const shard = shards[index];
    shard.duration = totals[index];
    for (const project of projects) {
      shard.projects.add(project);
      shard.lines.push(`[${project}] > ${file}`);
    }
  }
  return shards.map(shard => shard.lines);
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
  if (command === 'matrix') {
    appendFileSync(process.env.GITHUB_OUTPUT, `shards=${JSON.stringify(shardNumbers())}\n`);
  } else if (command === 'changed-specs') {
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
    const counts = verifyShards(inventory.tests, [reportTests(report, 'Playwright merged run had runtime errors')]);
    console.log(`Merged report matches single-stack inventory: ${counts.total} tests; ${JSON.stringify(report.stats)}`);
  } else {
    throw new Error('Expected matrix, changed-specs, run-changed, shard-lists, inventory or verify-report');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv[2]);
