// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { root } from './version.mjs';

const read = (file) => readFileSync(join(root, '.github/workflows', file), 'utf8');

/** The lines of a block that starts at `header` and ends at the next line indented as far or less. */
function block(lines, header) {
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return [];
  const indent = header.length - header.trimStart().length;
  const end = lines.findIndex((line, index) => index > start && line.trim() && line.length - line.trimStart().length <= indent);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const onBlock = (text) => block(text.split('\n'), 'on:');

/** The push trigger's inline branch list, as written in the workflow. */
function pushBranches(text) {
  const line = block(onBlock(text), '  push:').find((entry) => entry.startsWith('    branches: ['));
  assert.ok(line, 'push trigger has an inline branch list');
  return line.slice('    branches: ['.length, line.lastIndexOf(']')).split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
}

const reuseJob = (text) => block(text.split('\n'), '  reuse:');
const reuseIf = "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/next')";

test('the check workflows run on next, start by hand, and reuse a passed run on main and next pushes', () => {
  for (const file of ['ci.yml', 'compliance.yml', 'e2e.yml', 'memory.yml', 'image.yml']) {
    const text = read(file);
    const branches = pushBranches(text);
    assert.ok(branches.includes('main') && branches.includes('next'), `${file} pushes: ${branches}`);
    assert.ok(onBlock(text).some((line) => /^ {2}workflow_dispatch:/.test(line)), `${file} has workflow_dispatch`);
    const conditions = reuseJob(text).filter((line) => line.startsWith('    if: '));
    assert.deepEqual(conditions, [`    if: ${reuseIf}`], file);
  }
});

test('End-to-end reuses a push run, or a dispatch whose report job passed', () => {
  const step = reuseJob(read('e2e.yml')).join('\n');
  for (const needed of ['.event == "push"', 'workflow_dispatch', '"report"']) assert.ok(step.includes(needed), needed);
});

test('release and upgrade run on next; the other workflows keep their triggers', () => {
  for (const file of ['release.yml', 'upgrade.yml']) assert.ok(pushBranches(read(file)).includes('next'), file);
  assert.deepEqual(pushBranches(read('image-scan.yml')), ['task/**']);
  for (const file of ['prerelease.yml', 'advisories.yml', 'cla.yml']) assert.ok(!read(file).includes('next'), file);
});
