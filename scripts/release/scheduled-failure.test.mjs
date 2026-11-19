// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { failureLabel, reportScheduledFailure } from './scheduled-failure.mjs';

const context = {
  eventName: 'schedule', ref: 'refs/heads/main', workflow: 'Image scan',
  repo: { owner: 'example', repo: 'app' }, serverUrl: 'https://github.com', runId: 123, runAttempt: 2,
};
const title = 'Scheduled workflow failed: Image scan';
const body = 'Workflow: Image scan\nRun: https://github.com/example/app/actions/runs/123/attempts/2\nDate: 2026-11-16 (UTC)';

function fixture(issues = [], labelStatus = 404) {
  const calls = [];
  const rest = { issues: Object.fromEntries(['listForRepo', 'createComment', 'getLabel', 'createLabel', 'create'].map((method) => [method, async (args) => {
    calls.push([method, args]);
    if (method === 'getLabel' && labelStatus !== 200) throw Object.assign(new Error('label lookup'), { status: labelStatus });
  }])) };
  const github = { rest, paginate: async (method, args) => { await method(args); return issues; } };
  return { calls, options: { github, context, failed: true, now: new Date('2026-11-16T20:00:00Z') } };
}

test('comments on the open issue with the exact workflow title and fixed label', async () => {
  const { calls, options } = fixture([{ number: 9, title: 'Other workflow' }, { number: 10, title, pull_request: {} }, { number: 11, title }]);
  assert.equal((await reportScheduledFailure(options)).action, 'comment');
  assert.deepEqual(calls, [
    ['listForRepo', { ...context.repo, state: 'open', labels: failureLabel, per_page: 100 }],
    ['createComment', { ...context.repo, issue_number: 11, body }],
  ]);
});

test('creates the label and issue when no matching open issue exists', async () => {
  const { calls, options } = fixture();
  assert.equal((await reportScheduledFailure(options)).action, 'create');
  assert.deepEqual(calls.slice(1), [
    ['getLabel', { ...context.repo, name: failureLabel }],
    ['createLabel', { ...context.repo, name: failureLabel, color: 'd73a4a' }],
    ['create', { ...context.repo, title, body, labels: [failureLabel] }],
  ]);
});

test('uses an existing label and propagates permission errors', async () => {
  const existing = fixture([], 200);
  await reportScheduledFailure(existing.options);
  assert.deepEqual(existing.calls.map(([method]) => method), ['listForRepo', 'getLabel', 'create']);
  const denied = fixture([], 403);
  await assert.rejects(reportScheduledFailure(denied.options), { status: 403 });
  assert.deepEqual(denied.calls.map(([method]) => method), ['listForRepo', 'getLabel']);
});

test('does nothing for other events, branches, or nonfailures', async () => {
  for (const override of [
    { eventName: 'push' }, { eventName: 'pull_request' }, { eventName: 'workflow_dispatch' },
    { ref: 'refs/heads/task/example' }, { ref: 'refs/tags/main' },
  ]) {
    const { calls, options } = fixture();
    assert.deepEqual(await reportScheduledFailure({ ...options, context: { ...context, ...override } }), { action: 'skip' });
    assert.deepEqual(calls, []);
  }
  const { calls, options } = fixture();
  assert.deepEqual(await reportScheduledFailure({ ...options, failed: false }), { action: 'skip' });
  assert.deepEqual(calls, []);
});

test('another workflow creating the shared label does not lose the report', async () => {
  const { calls, options } = fixture();
  let lookups = 0;
  options.github.rest.issues.getLabel = async () => {
    if (lookups++ === 0) throw Object.assign(new Error('missing'), { status: 404 });
  };
  options.github.rest.issues.createLabel = async () => { throw Object.assign(new Error('already exists'), { status: 422 }); };
  await reportScheduledFailure(options);
  assert.equal(lookups, 2);
  assert.equal(calls.at(-1)[0], 'create');
});

test('dry runs show creation and comment plans without any write requests', async () => {
  for (const issues of [[], [{ number: 11, title }]]) {
    const { calls, options } = fixture(issues);
    const plan = await reportScheduledFailure({ ...options, dryRun: true });
    assert.equal(plan.action, issues.length ? 'comment' : 'create');
    assert.equal(plan.body, body);
    assert.deepEqual(calls.map(([method]) => method), ['listForRepo']);
  }
});

test('each scheduled workflow gates the failure job and waits for every other job', () => {
  for (const name of ['advisories', 'e2e', 'image-scan', 'memory', 'prerelease']) {
    const source = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const start = source.indexOf('  scheduled-failure:\n');
    assert.notEqual(start, -1, `${name}.yml has no scheduled-failure job`);
    const next = source.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    // Only the reporter job's own lines, so a later job's settings can't satisfy the checks below.
    const job = next === -1 ? source.slice(start) : source.slice(start, start + 1 + next + 1);
    // A job timeout can yield 'cancelled' in needs even when the workflow's cancelled() check is false.
    assert.match(job, /if: >-\n\s+\$\{\{ !cancelled\(\) && github.event_name == 'schedule' && github.ref == 'refs\/heads\/main' &&\n\s+\(contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)\) \}\}/);
    assert.match(job, /permissions:\n {6}contents: read\n {6}issues: write/);
    assert.match(job, /reportScheduledFailure\(\{ github, context, failed: true \}\)/);
    const dependencies = job.match(/needs: \[([^\]]+)\]/)[1].split(', ');
    const jobs = source.slice(source.indexOf('\njobs:\n'));
    assert.deepEqual(dependencies.sort(), [...jobs.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]).filter((id) => id !== 'scheduled-failure').sort());
  }
});

test('scheduled runs use their own workflow concurrency group when in-progress runs can be cancelled', () => {
  for (const [name, suffix] of [['e2e', "-${{ inputs.ux_pass && 'ux' || 'suite' }}"], ['image-scan', ''], ['memory', '']]) {
    const source = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const scheduleOrRef = "${{ github.event_name == 'schedule' && 'scheduled' || github.ref }}";
    assert.ok(source.includes(`\nconcurrency:\n  group: ${name}-${scheduleOrRef}${suffix}\n  cancel-in-progress: true\n`), name);
  }
});
