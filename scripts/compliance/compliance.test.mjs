// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { hasHeader, headerSyntax, checkHeaders } from './headers.mjs';
import { allowed, evaluate, licenseAllowed, noticeFiles, packageLicense, validateApprovals } from './license.mjs';
import { generateNotices, graphPaths, json, sha256 } from './inventory.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cache = join(root, 'scripts/compliance/.cache');
const require = createRequire(import.meta.url);

function temporary(t) {
  mkdirSync(cache, { recursive: true });
  const path = mkdtempSync(join(cache, 'fixture-'));
  t.after(() => {
    assert.ok(resolve(path).startsWith(resolve(cache) + sep));
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

test('optional peer tools are excluded from production but direct and bundled dependencies remain', (t) => {
  const root = temporary(t);
  const node = (name, manifest = {}, dependencies = {}) => {
    const path = join(root, name.replaceAll('/', '-'));
    mkdirSync(path);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, ...manifest }));
    return { path, dependencies };
  };
  for (const platform of ['win32-x64', 'linux-x64', 'linux-arm64']) {
    const native = node(`@esbuild/${platform}`);
    const tool = node(`vitest-${platform}`, {}, { native });
    const explicit = node(`explicit-${platform}`);
    const required = node(`required-${platform}`);
    const auth = node(`auth-${platform}`, {
      peerDependenciesMeta: { vitest: { optional: true }, explicit: { optional: true } },
      dependencies: { explicit: '1' },
    }, { vitest: tool, explicit, required });
    const filtered = graphPaths([auth], new Set(), { skipOptionalPeers: true });
    assert.ok(filtered.has(auth.path));
    assert.ok(filtered.has(explicit.path));
    assert.ok(filtered.has(required.path));
    assert.equal(filtered.has(tool.path), false);
    assert.equal(filtered.has(native.path), false);
    assert.ok(graphPaths([auth]).has(tool.path)); // Still license-check dev tools.
    assert.ok(graphPaths([auth, tool], new Set(), { skipOptionalPeers: true }).has(native.path));
    const notice = generateNotices({ packages: [{ name: 'optional-in-bundle', version: '1', license: 'MIT', runtime: false, bundled: true, notices: [{ name: 'LICENSE', text: 'Kept' }] }], assets: [] });
    assert.match(notice, /optional-in-bundle@1/);
  }
});

for (const fixture of json(new URL('./fixtures/licenses.json', import.meta.url))) {
  test(fixture.name, () => assert.equal(licenseAllowed(fixture.pkg), fixture.allowed));
}

test('allowlist contains exactly the agreed general licenses', () => {
  assert.equal(allowed.size, 11);
  for (const license of allowed) assert.ok(evaluate(license, (value) => allowed.has(value)));
  for (const expression of ['MIT AND', 'MIT Apache-2.0', '(MIT))', '', 'MIT OR OR Apache-2.0', 'MIT WITH', 'MIT WITH AND OR MIT']) {
    assert.equal(evaluate(expression, () => true), false, expression);
  }
});

test('approval is bound to package, version, and complete expression', () => {
  const pkg = { name: 'special', version: '1.0.0', license: 'MIT AND Zlib', runtime: false, bundled: false };
  const approval = { name: pkg.name, version: pkg.version, license: pkg.license, reason: 'Reviewed notice', approved: '2026-01-01' };
  assert.ok(licenseAllowed(pkg, [approval]));
  assert.equal(licenseAllowed({ ...pkg, version: '1.0.1' }, [approval]), false);
  assert.equal(licenseAllowed({ ...pkg, name: 'different' }, [approval]), false);
  assert.equal(licenseAllowed({ ...pkg, license: 'Zlib' }, [approval]), false);
  assert.throws(() => validateApprovals([{ ...approval, version: '*' }]), /exact/);
  assert.throws(() => validateApprovals([{ ...approval, approved: '' }]), /approved date/);
  assert.throws(() => validateApprovals([{ ...approval, approved: 'yesterday' }]), /approved date/);
});

test('approvals and CC-BY-4.0 never cover shipped or unproven packages', () => {
  const approval = { name: 'tool', version: '1.0.0', license: 'Python-2.0', reason: 'Build tool', approved: '2026-01-01' };
  const tool = { name: 'tool', version: '1.0.0', license: 'Python-2.0', runtime: false, bundled: false };
  const data = { name: 'data', version: '1.0.0', license: 'CC-BY-4.0', buildTimeOnly: true, runtime: false, bundled: false };
  assert.ok(licenseAllowed(tool, [approval]));
  assert.ok(licenseAllowed(data));
  for (const change of [{ runtime: true }, { bundled: true }, { bundled: undefined }]) {
    assert.equal(licenseAllowed({ ...tool, ...change }, [approval]), false, JSON.stringify(change));
    assert.equal(licenseAllowed({ ...data, ...change }), false, JSON.stringify(change));
  }
});

test('bundle evidence comes from the actual server and web builds', async () => {
  const { bundleInputs } = await import('./bundles.mjs');
  const { server, web } = await bundleInputs(root);
  const has = (inputs, name) => [...inputs].some((path) => path.includes(`${sep}node_modules${sep}${name}${sep}`));
  assert.ok(has(server, 'hono'));
  assert.ok(has(web, 'react-dom'));
  for (const inputs of [server, web]) {
    assert.equal(has(inputs, 'caniuse-lite'), false);
    assert.equal(has(inputs, 'argparse'), false);
  }
});

test('LICENSE fallback detects png-js-style MIT but cannot override a declared blocker', () => {
  const mit = readFileSync(new URL('./templates/MIT.txt', import.meta.url), 'utf8');
  const notices = [{ name: 'LICENSE', text: mit }];
  assert.equal(packageLicense({ name: 'png-js' }, notices), '(MIT)');
  assert.equal(packageLicense({ license: 'MIT AND Zlib' }, notices), 'MIT AND Zlib');
  assert.equal(packageLicense({}, [{ name: 'LICENSE', text: 'All rights reserved' }]), null);
  assert.equal(packageLicense({}, [{ name: 'LICENSE', text: mit + '\nNo commercial use is permitted.' }]), null);
  assert.equal(packageLicense({}, [{ name: 'README.md', text: mit }]), null);
  assert.equal(packageLicense({}, [...notices, { name: 'COPYING', text: 'Unrecognized second license' }]), null);
  assert.equal(packageLicense({}, [{ name: 'LICENSE', text: 'SPDX-License-Identifier: MIT AND Zlib' }]), '((MIT AND Zlib))');
});

test('disallowed-license fixture exits nonzero through the production policy assertion', () => {
  const module = pathToFileURL(join(root, 'scripts/compliance/license.mjs')).href;
  const fixture = json(new URL('./fixtures/licenses.json', import.meta.url)).find((entry) => entry.pkg.name === 'pako');
  const code = `import { assertLicenseAllowed } from ${JSON.stringify(module)}; assertLicenseAllowed(${JSON.stringify(fixture.pkg)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Disallowed license: pako@1.0.11: \(MIT AND Zlib\)/);
});

for (const fixture of json(new URL('./fixtures/headers.json', import.meta.url))) {
  test(`SPDX fixture ${fixture.path} ${fixture.allowed ? 'passes' : 'fails'}`, () => assert.equal(hasHeader(fixture.path, fixture.content), fixture.allowed));
}

test('every supported source syntax rejects a missing header', () => {
  for (const path of ['x.js', 'x.jsx', 'x.mjs', 'x.cjs', 'x.ts', 'x.tsx', 'x.mts', 'x.cts', 'x.jsonc', 'x.css', 'x.sql', 'x.html', 'x.svg', 'x.yaml', 'x.sh', 'x.ps1', 'x.py', 'x.go', 'Dockerfile', 'Caddyfile', '.env.example']) {
    assert.equal(hasHeader(path, 'plain content'), false, path);
  }
  assert.equal(headerSyntax('package.json'), null);
  assert.equal(headerSyntax('Noto.ttf'), null);
  assert.throws(() => hasHeader('new.unknown', 'content'), /Unclassified/);
});

test('a tracked missing-header fixture makes the actual CLI fail; untracked files are excluded', (t) => {
  const path = temporary(t);
  const git = (args) => execFileSync('git', ['-c', `safe.directory=${path.replaceAll('\\', '/')}`, ...args], { cwd: path, encoding: 'utf8' });
  git(['-c', 'core.autocrlf=false', 'init', '--quiet']);
  writeFileSync(join(path, 'tracked.ts'), '// SPDX-License-Identifier: AGPL-3.0-only\nexport {};\n');
  writeFileSync(join(path, 'untracked.ts'), 'export {};\n');
  git(['-c', 'core.autocrlf=false', 'add', 'tracked.ts']);
  assert.doesNotThrow(() => checkHeaders(path));
  writeFileSync(join(path, 'tracked.ts'), 'export {};\n');
  const module = pathToFileURL(join(root, 'scripts/compliance/cli.mjs')).href;
  const code = `import { main } from ${JSON.stringify(module)}; main(['--headers'], ${JSON.stringify(path)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked.ts: missing SPDX header/);
});

test('notices retain runtime, bundled dev, LICENSE, NOTICE and font text deterministically', () => {
  const packages = [
    { name: 'runtime', version: '1', license: 'MIT', upstream: '', runtime: true, notices: [{ name: 'LICENSE', text: 'Runtime license' }, { name: 'NOTICE', text: 'Required attribution' }] },
    { name: 'bundled-dev', version: '2', license: 'ISC', upstream: '', bundled: true, notices: [{ name: 'LICENSE', text: 'Bundled license' }] },
    { name: 'build-only', version: '3', license: 'MIT', upstream: '', notices: [] },
  ];
  const assets = [{ name: 'Font', path: 'font.ttf', license: 'OFL-1.1', sha256: 'hash', upstream: '', notice: 'OFL.txt', noticeText: 'Font notice' }];
  const output = generateNotices({ packages, assets });
  assert.match(output, /runtime@1/);
  assert.match(output, /Required attribution/);
  assert.match(output, /bundled-dev@2/);
  assert.match(output, /Font notice/);
  assert.doesNotMatch(output, /build-only@3/);
  assert.equal(generateNotices({ packages: [...packages].reverse(), assets }), output);
  assert.throws(() => generateNotices({ packages: [{ ...packages[0], notices: [] }], assets: [] }), /no redistributable/);
});

const workflow = readFileSync(join(root, '.github/workflows/cla.yml'), 'utf8');
const script = workflow.split('          script: |\n')[1].split('\n').map((line) => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('require', 'context', 'github', 'core', script);
const phrase = 'I have read the CLA Document and I hereby sign the CLA';

function claFixture(options = {}) {
  const text = options.text ?? 'Version 1.0\nPublic fixture contributor agreement.\n';
  const hash = sha256(text);
  const statuses = [];
  const failures = [];
  const writes = [];
  const comments = options.comments ?? [];
  let ledger = options.ledger;
  let branch = Boolean(ledger);
  const author = { id: 42, login: 'contributor', type: 'User', ...options.author };
  const pr = { state: 'open', user: author, head: { sha: 'current-head' }, base: { repo: { full_name: 'plaingym/plaingym' } } };
  const context = {
    repo: { owner: 'plaingym', repo: 'plaingym' }, eventName: options.eventName ?? 'pull_request_target',
    runId: 100, serverUrl: 'https://github.com',
    payload: { pull_request: { number: 1 }, issue: { number: 1, pull_request: {} }, comment: { id: 10 } },
  };
  const file = (content) => ({ type: 'file', sha: 'blob', encoding: 'base64', content: Buffer.from(content).toString('base64') });
  const notFound = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  const api = {
    pulls: { get: async () => ({ data: pr }) },
    repos: {
      createCommitStatus: async (value) => statuses.push(value),
      getCollaboratorPermissionLevel: async () => ({ data: { permission: options.permission ?? 'none' } }),
      get: async () => ({ data: { default_branch: 'main' } }),
      getContent: async (value) => {
        if (value.path === 'CLA.md') { assert.equal(value.ref, 'default-sha'); return { data: file(text) }; }
        assert.equal(value.path, 'signatures/cla.json');
        assert.equal(value.ref, 'cla-signatures');
        if (!ledger) return notFound();
        return { data: file(JSON.stringify(ledger)) };
      },
      createOrUpdateFileContents: async (value) => {
        if (options.writeError) throw new Error('Write unavailable');
        assert.equal(value.branch, 'cla-signatures');
        writes.push(value);
        ledger = JSON.parse(Buffer.from(value.content, 'base64').toString('utf8'));
      },
    },
    git: {
      getRef: async (value) => value.ref === 'heads/main' ? { data: { object: { sha: 'default-sha' } } }
        : branch ? { data: {} } : notFound(),
      createRef: async (value) => { assert.equal(value.ref, 'refs/heads/cla-signatures'); branch = true; },
    },
    issues: {
      listComments: async () => {},
      getComment: async () => ({ data: options.comment ?? {
        id: 10, user: author, body: phrase, updated_at: '2026-01-02T00:00:00Z',
        issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/1',
      } }),
      createComment: async (value) => {
        const comment = { ...value, id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, updated_at: '2026-01-01T00:00:00Z' };
        comments.push(comment);
        return { data: comment };
      },
      updateComment: async (value) => { comments.find((comment) => comment.id === value.comment_id).body = value.body; },
    },
  };
  return {
    hash, statuses, failures, writes, comments, context,
    ledger: () => ledger,
    run: () => execute(require, context, { rest: api, paginate: async () => comments }, { setFailed: (message) => failures.push(message) }),
  };
}

test('privileged CLA workflow has one pinned action and no checkout or repository-code execution', () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /group: cla-signatures-/);
  assert.equal([...workflow.matchAll(/- uses:/g)].length, 1);
  assert.match(workflow, /uses: actions\/github-script@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /uses:.*checkout|^\s+run:|require\(['"]\.\/|\$\{\{\s*github\.event/m);
  for (const path of ['cla.yml', 'compliance.yml']) {
    const content = readFileSync(join(root, '.github/workflows', path), 'utf8');
    for (const action of content.matchAll(/- uses:\s+([^\s#]+)/g)) assert.match(action[1], /@[0-9a-f]{40}$/);
  }
});

test('unsigned author fails and receives a hash-bound prompt', async () => {
  const fixture = claFixture();
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.match(fixture.comments[0].body, new RegExp(fixture.hash));
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.statuses.at(-1).sha, 'current-head');
});

test('author signs once; record includes identity, comment, timestamp and agreement version/hash', async () => {
  const fixture = claFixture();
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.deepEqual(fixture.ledger().signatures[0], {
    userId: 42, login: 'contributor', commentId: 10, signedAt: '2026-01-02T00:00:00Z',
    claVersion: '1.0', claSha256: fixture.hash, claBlobSha: 'blob',
  });
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
});

test('signature identity is user ID, never a recycled login', async () => {
  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  const fixture = claFixture({ ledger: { schemaVersion: 1, signatures: [{ userId: 99, login: 'contributor', claSha256: sha256(text) }] } });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
});

test('forged, early, and unrelated signing comments do not grant a signature', async () => {
  for (const override of [
    { user: { id: 99, type: 'User' } },
    { updated_at: '2025-01-01T00:00:00Z' },
    { issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/2' },
    { body: phrase + '; require("node:child_process").execSync("untrusted")' },
  ]) {
    const comment = { id: 10, user: { id: 42, type: 'User' }, body: phrase, updated_at: '2026-01-02T00:00:00Z', issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/1', ...override };
    const fixture = claFixture({ comment });
    await fixture.run();
    fixture.context.eventName = 'issue_comment';
    await fixture.run();
    assert.equal(fixture.statuses.at(-1).state, 'failure');
    assert.equal(fixture.writes.length, 0);
  }
});

test('maintainers and exact dependency bot identities are exempt', async () => {
  for (const options of [{ permission: 'admin' }, { permission: 'maintain' }, { author: { login: 'dependabot[bot]', type: 'Bot' } }, { author: { login: 'renovate[bot]', type: 'Bot' } }]) {
    const fixture = claFixture(options);
    await fixture.run();
    assert.equal(fixture.statuses.at(-1).state, 'success');
    assert.equal(fixture.writes.length, 0);
  }
});

test('publication placeholders and storage failures fail closed', async () => {
  const incomplete = claFixture({ text: 'Version 1.0\n[TODO: maintainer name]\n' });
  await incomplete.run();
  assert.equal(incomplete.statuses.at(-1).state, 'failure');
  assert.match(incomplete.failures[0], /placeholders/);
  const fixture = claFixture({ writeError: true });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.writes.length, 0);
});
test('fallback reads an actual license file, with no manifest metadata', (t) => {
  const path = temporary(t);
  writeFileSync(join(path, 'LICENSE'), 'SPDX-License-Identifier: MIT\nFixture Authors\n');
  writeFileSync(join(path, 'NOTICE'), 'Required notice\n');
  const notices = noticeFiles(path);
  assert.equal(notices.length, 2);
  assert.equal(packageLicense({ name: 'metadata-free' }, notices), '((MIT))');
});

test('graph inventory includes transitive and development packages; missing required nodes fail', (t) => {
  const path = temporary(t);
  const child = join(path, 'child');
  mkdirSync(child);
  const tree = [{ path, devDependencies: { tool: { path: child } }, dependencies: { skipped: { from: 'other-platform', version: '1', path: join(path, 'absent') } } }];
  assert.throws(() => graphPaths(tree), /not installed/);
  assert.equal(graphPaths(tree, new Set(['other-platform@1'])).size, 2);
});

test('bundled font and supplemental upstream notices retain their provenance hashes', () => {
  for (const entry of [
    ...json(join(root, 'scripts/compliance/assets.json')),
    ...json(join(root, 'scripts/compliance/notices/provenance.json')),
  ]) assert.equal(sha256(readFileSync(join(root, entry.path))), entry.sha256, entry.path);
});
