// SPDX-License-Identifier: AGPL-3.0-only
import assert, { AssertionError } from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { hasHeader, headerSyntax, checkHeaders } from './headers.mjs';
import { allowed, evaluate, licenseAllowed, noticeFiles, packageLicense, validateApprovals } from './license.mjs';
import { generateNotices, graphPaths, json, sha256 } from './inventory.mjs';
import { shellRequests } from '../check-shell-requests.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cache = join(root, 'scripts/compliance/.cache');
const require = createRequire(import.meta.url);

test('shell request budget exempts assets but reserves room for runtime requests', () => {
  const assets = Array.from({ length: 60 }, (_, i) => `<link rel="modulepreload" href="/assets/chunk-${i}.js">`).join('');
  assert.deepEqual(shellRequests(assets), { resources: 60, counted: 1 });
  const counted = Array.from({ length: 24 }, (_, i) => `<script src="/other/chunk-${i}.js"></script>`).join('');
  assert.throws(() => shellRequests(counted), /25 Cloudflare-counted requests/);
  assert.deepEqual(shellRequests('<script src="/assets/main.js"></script><link rel="stylesheet" href="/styles.css">'), { resources: 2, counted: 2 });
});

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
  for (const path of ['x.js', 'x.jsx', 'x.mjs', 'x.cjs', 'x.ts', 'x.tsx', 'x.mts', 'x.cts', 'x.jsonc', 'x.css', 'x.sql', 'x.html', 'x.svg', 'x.yaml', 'x.sh', 'x.ps1', 'x.py', 'x.go', 'x.service', 'x.timer', 'Dockerfile', 'Caddyfile', '.env.example']) {
    assert.equal(hasHeader(path, 'plain content'), false, path);
  }
  assert.equal(headerSyntax('package.json'), null);
  assert.equal(headerSyntax('Noto.ttf'), null);
  assert.equal(headerSyntax('deploy/release-signing.pem'), null);
  assert.equal(hasHeader('plaingym-update.timer', '# SPDX-License-Identifier: AGPL-3.0-only\n[Timer]\n'), true);
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
const revisedAgreement = 'Version 2.0\nRevised fixture contributor agreement.\n';

function claFixture(options = {}) {
  const text = options.text ?? 'Version 1.0\nPublic fixture contributor agreement.\n';
  const hash = sha256(text);
  const statuses = [];
  const failures = [];
  const writes = [];
  const comments = options.comments ?? [];
  const commentCalls = { list: 0, create: 0, update: 0, delete: 0 };
  const agreementReads = [];
  let defaultSha = 'default-sha';
  let refError;
  const agreements = new Map([[defaultSha, text]]);
  let ledger = options.ledger;
  let branch = Boolean(ledger);
  let revision = 1, conflicts = options.writeConflicts ?? 0;
  const author = { id: 42, login: 'contributor', type: 'User', ...options.author };
  // GitHub's commit listing carries the linked account as `author` (null when the email has none).
  const commits = options.commits ?? [{ sha: 'current-head', author }];
  const pr = {
    number: 1, state: 'open', user: author, commits: commits.length, head: { sha: 'current-head' },
    base: { repo: { full_name: 'plaingym/plaingym' } }, ...options.pr,
  };
  const otherPulls = options.otherPulls ?? [];
  const permissions = { [author.login]: options.permission ?? 'none', ...options.permissions };
  const permissionCalls = [];
  const paginated = [];
  let signingComment = options.comment ?? {
    id: 10, user: author, body: phrase, updated_at: '2026-01-02T00:00:00Z',
    issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/1',
  };
  const context = {
    repo: { owner: 'plaingym', repo: 'plaingym' }, eventName: options.eventName ?? 'pull_request_target',
    runId: 100, serverUrl: 'https://github.com',
    payload: { pull_request: { number: 1 }, issue: { number: 1, pull_request: {} }, comment: { id: 10 } },
  };
  const file = (content, sha = `blob-${sha256(content)}`) => ({ type: 'file', sha, encoding: 'base64', content: Buffer.from(content).toString('base64') });
  const notFound = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  const api = {
    pulls: { get: async () => ({ data: pr }), listCommits: async () => {}, list: async () => {} },
    repos: {
      createCommitStatus: async (value) => statuses.push(value),
      getCollaboratorPermissionLevel: async (value) => {
        assert.equal(value.owner, context.repo.owner);
        assert.equal(value.repo, context.repo.repo);
        permissionCalls.push(value.username);
        return { data: { permission: permissions[value.username] ?? 'none' } };
      },
      get: async () => ({ data: { default_branch: 'main' } }),
      getContent: async (value) => {
        if (value.path === 'CLA.md') {
          assert.equal(value.owner, context.repo.owner);
          assert.equal(value.repo, context.repo.repo);
          assert.ok(agreements.has(value.ref), 'agreement read must use a pinned revision');
          agreementReads.push(value.ref);
          return { data: file(agreements.get(value.ref)) };
        }
        assert.equal(value.path, 'signatures/cla.json');
        assert.equal(value.ref, 'cla-signatures');
        if (!ledger) return notFound();
        return { data: file(JSON.stringify(ledger), 'ledger-' + revision) };
      },
      createOrUpdateFileContents: async (value) => {
        if (options.writeError) throw new Error('Write unavailable');
        assert.equal(value.branch, 'cla-signatures');
        assert.equal(value.sha, ledger ? 'ledger-' + revision : undefined);
        if (conflicts-- > 0) {
          ledger = { schemaVersion: 1, signatures: [...(ledger?.signatures ?? []), ...(options.concurrentSignatures ?? [{ userId: 98 + revision, claSha256: hash }])] };
          revision++;
          // GitHub refuses a stale sha with 409 and a sha-less write over an existing file with 422.
          throw Object.assign(new Error('Ledger changed'), { status: value.sha ? 409 : 422 });
        }
        writes.push(value);
        ledger = JSON.parse(Buffer.from(value.content, 'base64').toString('utf8'));
        revision++;
      },
    },
    git: {
      getRef: async (value) => {
        assert.equal(value.owner, context.repo.owner);
        assert.equal(value.repo, context.repo.repo);
        if (value.ref === 'heads/main') {
          if (refError) throw refError;
          return { data: { object: { sha: defaultSha } } };
        }
        assert.equal(value.ref, 'heads/cla-signatures');
        return branch ? { data: {} } : notFound();
      },
      createRef: async (value) => {
        assert.equal(value.ref, 'refs/heads/cla-signatures'); branch = true;
        if (options.branchConflict) throw Object.assign(new Error('Reference already exists'), { status: 422 });
      },
    },
    issues: {
      listComments: async () => {},
      getComment: async () => ({ data: signingComment }),
      createComment: async (value) => {
        commentCalls.create++;
        const comment = { ...value, id: Math.max(4, ...comments.map((comment) => comment.id)) + 1, user: { login: 'github-actions[bot]', type: 'Bot' }, updated_at: '2026-01-01T00:00:00Z' };
        comments.push(comment);
        return { data: comment };
      },
      updateComment: async (value) => {
        commentCalls.update++;
        const comment = comments.find((comment) => comment.id === value.comment_id);
        comment.body = value.body;
        comment.updated_at = new Date(Math.max(Date.parse('2026-01-03T00:00:00Z'), Date.parse(comment.updated_at) + 1000)).toISOString();
      },
      deleteComment: async (value) => {
        commentCalls.delete++;
        const index = comments.findIndex((comment) => comment.id === value.comment_id);
        if (index < 0) return notFound();
        comments.splice(index, 1);
      },
    },
  };
  return {
    text, hash, statuses, failures, writes, comments, commentCalls, agreementReads, context, permissionCalls, paginated,
    ledger: () => ledger,
    setComment: (comment) => { signingComment = comment; },
    setAgreement: (sha, content) => {
      agreements.set(sha, content);
      defaultSha = sha;
    },
    setRefError: (error) => { refError = error; },
    run: async (hooks = {}) => {
      let firstAssertion;
      const captureAssertion = (call) => async (...args) => {
        try {
          return await call(...args);
        } catch (error) {
          if (error instanceof AssertionError) firstAssertion ??= error;
          throw error;
        }
      };
      const getContent = captureAssertion(api.repos.getContent);
      const runContext = { ...context, ...hooks.context };
      const runNumber = runContext.payload.pull_request?.number ?? runContext.payload.issue?.number;
      await execute(require, runContext, {
        rest: {
          ...api,
          repos: {
            ...api.repos,
            createCommitStatus: captureAssertion(async (value) => {
              await hooks.beforeStatus?.(value);
              return api.repos.createCommitStatus(value);
            }),
            getContent: captureAssertion(async (value) => {
              if (value.path === 'CLA.md') await hooks.beforeAgreementRead?.(value.ref);
              try {
                return await getContent(value);
              } finally {
                if (value.path === 'signatures/cla.json') await hooks.afterLedgerRead?.();
              }
            }),
            createOrUpdateFileContents: captureAssertion(api.repos.createOrUpdateFileContents),
          },
          git: { getRef: captureAssertion(api.git.getRef), createRef: captureAssertion(api.git.createRef) },
          issues: {
            ...api.issues,
            createComment: captureAssertion(async (value) => {
              await hooks.beforeCreateComment?.();
              return api.issues.createComment(value);
            }),
            updateComment: captureAssertion(async (value) => {
              await hooks.beforeUpdateComment?.();
              return api.issues.updateComment(value);
            }),
          },
        },
        paginate: captureAssertion(async (method, params) => {
          if (method === api.pulls.listCommits) {
            // The commits of the pull request the event names.
            assert.deepEqual(params, { owner: 'plaingym', repo: 'plaingym', pull_number: runNumber, per_page: 100 });
            paginated.push('listCommits');
            return structuredClone(commits);
          }
          if (method === api.pulls.list) {
            assert.deepEqual(params, { owner: 'plaingym', repo: 'plaingym', state: 'open', per_page: 100 });
            paginated.push('list');
            return structuredClone([{ number: pr.number, user: pr.user, head: pr.head, base: pr.base }, ...otherPulls]);
          }
          assert.equal(method, api.issues.listComments);
          paginated.push('listComments');
          assert.deepEqual(params, { owner: 'plaingym', repo: 'plaingym', issue_number: 1, per_page: 100 });
          commentCalls.list++;
          const snapshot = structuredClone(comments);
          await hooks.afterListComments?.();
          return snapshot;
        }),
      }, { setFailed: (message) => failures.push(message) });
      // The workflow can catch a fixture assertion and report an ordinary failed status.
      if (firstAssertion) throw firstAssertion;
    },
  };
}

test('privileged CLA workflow has one pinned action and no checkout or repository-code execution', () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /issue_comment:/);
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.equal([...workflow.matchAll(/- uses:/g)].length, 1);
  assert.match(workflow, /uses: actions\/github-script@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /uses:.*checkout|^\s+run:|require\(['"]\.\/|\$\{\{\s*github\.event/m);
  for (const path of ['cla.yml', 'compliance.yml']) {
    const content = readFileSync(join(root, '.github/workflows', path), 'utf8');
    for (const action of content.matchAll(/- uses:\s+([^\s#]+)/g)) assert.match(action[1], /@[0-9a-f]{40}$/);
  }
});

test('privileged CLA job holds only the permissions its script uses, and the workflow none', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const job = /^ {4}permissions:\n((?: {6}[a-z-]+: (?:read|write)\n)+)/m.exec(workflow);
  assert.ok(job, 'the job declares its permissions');
  assert.deepEqual(job[1].trim().split('\n').map((line) => line.trim()).sort(),
    ['contents: write', 'issues: write', 'pull-requests: write', 'statuses: write']);
  // The workflow's empty grant and the job's own: no step widens them.
  assert.equal([...workflow.matchAll(/^ *permissions:/gm)].length, 2);
});

test('a closed pull request, or one whose base is another repository, gets no status and no prompt', async () => {
  for (const pr of [{ state: 'closed' }, { base: { repo: { full_name: 'someone/fork' } } }]) {
    const fixture = claFixture({ pr });
    await fixture.run();
    assert.equal(fixture.statuses.length, 0);
    assert.equal(fixture.comments.length, 0);
    assert.equal(fixture.writes.length, 0);
  }
});

test('an unlisted bot is not exempt, and a bot login only exempts a bot account', async () => {
  for (const author of [{ login: 'helper[bot]', type: 'Bot' }, { login: 'dependabot[bot]', type: 'User' }]) {
    const fixture = claFixture({ author });
    await fixture.run();
    assert.equal(fixture.statuses.at(-1).state, 'failure');
    assert.equal(fixture.writes.length, 0);
  }
});

test('an unsigned pull request creates a hash-bound prompt and lists comments twice', async () => {
  const fixture = claFixture();
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.comments.length, 1);
  assert.match(fixture.comments[0].body, new RegExp(fixture.hash));
  assert.ok(fixture.comments[0].body.includes(`<!-- plaingym-cla-blob:blob-${fixture.hash} -->`));
  assert.deepEqual(fixture.commentCalls, { list: 2, create: 1, update: 0, delete: 0 });
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.statuses.at(-1).sha, 'current-head');
});

test('an unsigned pull request with a current prompt lists comments once without changing it', async () => {
  const fixture = claFixture();
  await fixture.run();
  await fixture.run();
  assert.deepEqual(fixture.commentCalls, { list: 3, create: 1, update: 0, delete: 0 });
  assert.equal(fixture.statuses.at(-1).state, 'failure');
});

test('a new default commit with the same agreement leaves a pending signature valid', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [prompt] = fixture.comments;
  const { body, updated_at } = prompt;
  fixture.setAgreement('unrelated-sha', fixture.text);

  await fixture.run();

  assert.equal(prompt.body, body);
  assert.equal(prompt.updated_at, updated_at);
  assert.deepEqual(fixture.commentCalls, { list: 3, create: 1, update: 0, delete: 0 });

  await fixture.run({ context: { eventName: 'issue_comment' } });
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.statuses.at(-1).state, 'success');
});

test('an unsigned run updates the earliest trusted prompt and removes a leftover duplicate without another scan', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [earliest] = fixture.comments;
  const currentBody = earliest.body;
  const staleBody = currentBody.replace(`<!-- plaingym-cla-blob:blob-${fixture.hash} -->\n`, '');
  earliest.body = staleBody;
  const later = { ...earliest, id: earliest.id + 1 };
  const untrusted = { ...earliest, id: earliest.id - 1, user: { ...earliest.user, type: 'User' } };
  fixture.comments.unshift(later, untrusted);

  await fixture.run();

  assert.equal(earliest.body, currentBody);
  assert.equal(later.body, staleBody);
  assert.equal(untrusted.body, staleBody);
  assert.deepEqual(fixture.comments.map((comment) => comment.id), [untrusted.id, earliest.id]);
  assert.deepEqual(fixture.commentCalls, { list: 3, create: 1, update: 1, delete: 1 });
});

test('an unsigned run cannot overwrite a prompt updated for a newer agreement', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [{ id }] = fixture.comments;
  let currentBody;

  await fixture.run({ afterLedgerRead: async () => {
    if (currentBody) return;
    fixture.setAgreement('revised-sha', revisedAgreement);
    await fixture.run({ context: { runId: 101 } });
    currentBody = fixture.comments[0].body;
    assert.ok(currentBody.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  } });

  assert.deepEqual(fixture.comments.map((comment) => [comment.id, comment.body]), [[id, currentBody]]);
  assert.deepEqual(fixture.commentCalls, { list: 5, create: 1, update: 1, delete: 0 });
});

test('an obsolete run publishes the updated agreement status for the same pull request head', async () => {
  const originalAgreement = 'Version 1.0\nPublic fixture contributor agreement.\n';
  for (const olderAgreementSigned of [false, true]) {
    const signedAgreement = olderAgreementSigned ? originalAgreement : revisedAgreement;
    const fixture = claFixture({ text: originalAgreement, ledger: {
      schemaVersion: 1, signatures: [{ userId: 42, claSha256: sha256(signedAgreement) }],
    } });
    if (!olderAgreementSigned) await fixture.run();
    const statusCount = fixture.statuses.length;
    let reads = 0;

    await fixture.run({ afterLedgerRead: async () => {
      // Pause just before the older run would publish success or signature required.
      if (++reads !== (olderAgreementSigned ? 1 : 2)) return;
      fixture.setAgreement('revised-sha', revisedAgreement);
      await fixture.run({ context: { runId: 101 } });
    } });

    const finalState = olderAgreementSigned ? 'failure' : 'success';
    assert.deepEqual(
      fixture.statuses.slice(statusCount).filter((status) => status.target_url.endsWith('/100')).map((status) => status.state),
      ['pending', finalState],
    );
    assert.equal(fixture.statuses.at(-1).state, finalState);
    assert.equal(fixture.statuses.at(-1).sha, 'current-head');
    assert.ok(fixture.statuses.at(-1).target_url.endsWith('/100'));
  }
});

test('an error in an obsolete run leaves the current agreement status in place', async () => {
  const fixture = claFixture({ ledger: {
    schemaVersion: 1, signatures: [{ userId: 42, claSha256: sha256(revisedAgreement) }],
  } });
  await fixture.run({ afterLedgerRead: async () => {
    fixture.setAgreement('revised-sha', revisedAgreement);
    await fixture.run({ context: { runId: 101 } });
    throw new Error('Ledger unavailable');
  } });

  assert.deepEqual(fixture.failures, ['Ledger unavailable']);
  assert.deepEqual(fixture.statuses.map((status) => status.state), ['pending', 'pending', 'success']);
});

test('an error whose agreement recheck also fails still reports the original error', async () => {
  const fixture = claFixture();
  await fixture.run({ afterLedgerRead: async () => {
    fixture.setRefError(Object.assign(new Error('Service unavailable'), { status: 503 }));
    throw new Error('Ledger unavailable');
  } });

  assert.deepEqual(fixture.failures, ['Ledger unavailable']);
  assert.deepEqual(fixture.statuses.map((status) => [status.state, status.description]), [
    ['pending', 'Checking contributor agreement'],
    ['failure', 'CLA check needs maintainer attention'],
  ]);
});

test('an error during the second pass checks the revised agreement before reporting failure', async () => {
  const fixture = claFixture();
  let reads = 0;
  await fixture.run({ afterLedgerRead: () => {
    if (++reads === 1) fixture.setAgreement('revised-sha', revisedAgreement);
    if (reads === 2) throw new Error('Ledger unavailable');
  } });

  assert.equal(reads, 2);
  assert.deepEqual(fixture.failures, ['Ledger unavailable']);
  assert.deepEqual(fixture.statuses.map((status) => [status.state, status.description]), [
    ['pending', 'Checking contributor agreement'],
    ['failure', 'CLA check needs maintainer attention'],
  ]);
});

test('an error reading the second pass agreement leaves the current agreement status in place', async () => {
  const fixture = claFixture({ ledger: {
    schemaVersion: 1, signatures: [{ userId: 42, claSha256: sha256(revisedAgreement) }],
  } });
  let lists = 0, revisedReads = 0;
  await fixture.run({
    afterListComments: async () => {
      if (++lists > 1) return;
      fixture.setAgreement('revised-sha', revisedAgreement);
      await fixture.run({ context: { runId: 101 } });
    },
    // The first revised read is the obsolete create's recheck; the second starts pass 2.
    beforeAgreementRead: (ref) => {
      if (ref === 'revised-sha' && ++revisedReads === 2) throw Object.assign(new Error('Agreement unavailable'), { status: 502 });
    },
  });

  assert.equal(revisedReads, 3);
  assert.deepEqual(fixture.failures, ['Agreement unavailable']);
  assert.deepEqual(fixture.statuses.map((status) => [status.state, status.target_url.split('/').at(-1)]), [
    ['pending', '100'], ['pending', '101'], ['success', '101'],
  ]);
});

test('a run repairs its obsolete prompt update in the second pass', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [earliest] = fixture.comments;
  earliest.body = `<!-- plaingym-cla:${fixture.hash} -->`;
  fixture.comments.push({ ...earliest, id: earliest.id + 1 });
  let currentBody;

  await fixture.run({ beforeUpdateComment: async () => {
    if (currentBody) return;
    fixture.setAgreement('revised-sha', revisedAgreement);
    await fixture.run({ context: { runId: 101 } });
    currentBody = earliest.body;
    assert.ok(currentBody.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  } });

  assert.deepEqual(fixture.comments.map((comment) => [comment.id, comment.body]), [[earliest.id, currentBody]]);
  assert.deepEqual(fixture.commentCalls, { list: 5, create: 1, update: 3, delete: 1 });
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.ok(fixture.statuses.at(-1).target_url.endsWith('/100'));
});

test('an obsolete creator refreshes the only signing prompt in the second pass', async () => {
  const fixture = claFixture();
  await fixture.run({ afterListComments: () => fixture.setAgreement('revised-sha', revisedAgreement) });
  assert.equal(fixture.comments.length, 1);
  assert.ok(fixture.comments[0].body.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  assert.ok(fixture.comments[0].body.includes('/blob/revised-sha/CLA.md'));
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.statuses.at(-1).description, 'CLA signature required; see the signing comment');
  assert.deepEqual(fixture.commentCalls, { list: 3, create: 1, update: 1, delete: 0 });
});

test('an obsolete creator deletes its own duplicate and keeps the earlier prompt', async () => {
  const fixture = claFixture();
  await fixture.run({ beforeCreateComment: async () => {
    fixture.setAgreement('revised-sha', revisedAgreement);
    await fixture.run({ context: { runId: 101 } });
  } });

  assert.deepEqual(fixture.comments.map((comment) => comment.id), [5]);
  assert.ok(fixture.comments[0].body.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  assert.deepEqual(fixture.commentCalls, { list: 5, create: 2, update: 0, delete: 1 });
  assert.ok(fixture.statuses.at(-1).target_url.endsWith('/100'));
});

test('an agreement change during signing keeps the original signature and refreshes the prompt', async () => {
  const fixture = claFixture();
  await fixture.run();
  const statusCount = fixture.statuses.length;
  let reads = 0;

  await fixture.run({ context: { eventName: 'issue_comment' }, afterLedgerRead: () => {
    if (++reads === 2) fixture.setAgreement('revised-sha', revisedAgreement);
  } });

  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.ledger().signatures.map((signature) => signature.claSha256), [fixture.hash]);
  assert.equal(fixture.comments.length, 1);
  assert.ok(fixture.comments[0].body.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  assert.ok(fixture.comments[0].body.includes('/blob/revised-sha/CLA.md'));
  assert.deepEqual(fixture.statuses.slice(statusCount).map((status) => status.state), ['pending', 'failure']);
});

test('two agreement changes leave the run pending after two passes', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [{ body }] = fixture.comments;
  const statusCount = fixture.statuses.length;
  const readCount = fixture.agreementReads.length;
  let lists = 0;

  await fixture.run({ afterListComments: () => {
    lists++;
    if (lists === 1) fixture.setAgreement('revised-sha', revisedAgreement);
    if (lists === 2) fixture.setAgreement('third-sha', 'Version 3.0\nThird fixture contributor agreement.\n');
  } });

  assert.deepEqual(fixture.agreementReads.slice(readCount), ['default-sha', 'revised-sha', 'revised-sha', 'third-sha']);
  assert.deepEqual(fixture.statuses.slice(statusCount).map((status) => status.state), ['pending']);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.comments[0].body, body);
  assert.deepEqual(fixture.commentCalls, { list: 4, create: 1, update: 0, delete: 0 });
});

test('a move of the default ref with the same agreement still allows a prompt refresh and duplicate removal', async () => {
  const fixture = claFixture();
  await fixture.run();
  const [earliest] = fixture.comments;
  const currentBody = earliest.body;
  earliest.body = '<!-- plaingym-cla:old -->';
  fixture.comments.push({ ...earliest, id: earliest.id + 1 });

  await fixture.run({ afterListComments: () => fixture.setAgreement('unrelated-sha', fixture.text) });

  assert.deepEqual(fixture.comments.map((comment) => [comment.id, comment.body]), [[earliest.id, currentBody]]);
  assert.deepEqual(fixture.commentCalls, { list: 3, create: 1, update: 1, delete: 1 });
});

test('a signing run checks the earliest trusted prompt, whatever order comments are listed in', async () => {
  const fixture = claFixture({ eventName: 'issue_comment' });
  await fixture.run({ context: { eventName: 'pull_request_target' } });
  const [earliest] = fixture.comments;
  fixture.comments.unshift({ ...earliest, id: earliest.id + 1, body: '<!-- plaingym-cla:old -->' });

  await fixture.run();

  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.statuses.at(-1).state, 'success');
});

test('author signs once; record includes identity, comment, timestamp and agreement version/hash', async () => {
  const fixture = claFixture();
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.deepEqual(fixture.ledger().signatures[0], {
    userId: 42, login: 'contributor', commentId: 10, signedAt: '2026-01-02T00:00:00Z',
    claVersion: '1.0', claSha256: fixture.hash, claBlobSha: `blob-${fixture.hash}`,
  });
  assert.equal(fixture.commentCalls.list, 3);
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.commentCalls.list, 3);
});

test('an unsigned run rechecks a stale ledger after an interleaved signing run succeeds', async () => {
  const fixture = claFixture();
  await fixture.run();
  const failedBefore = fixture.failures.length;
  let reads = 0;
  await fixture.run({ afterLedgerRead: async () => {
    if (++reads === 1) {
      await fixture.run({ context: { eventName: 'issue_comment', runId: 101 } });
      assert.equal(fixture.statuses.at(-1).state, 'success');
    }
  } });
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.failures.length, failedBefore);
  assert.equal(fixture.writes.length, 1);
});

test('an unsigned signing run reuses a prompt posted after its signing snapshot', async () => {
  const fixture = claFixture();
  let lists = 0;
  await fixture.run({ context: { eventName: 'issue_comment' }, afterListComments: async () => {
    if (++lists === 1) await fixture.run({ context: { runId: 101 } });
  } });
  assert.equal(fixture.comments.length, 1);
  assert.deepEqual(fixture.commentCalls, { list: 4, create: 1, update: 0, delete: 0 });
  assert.equal(fixture.writes.length, 0);
});

test('a signing success during an in-flight failure status is restored as the final status', async () => {
  const fixture = claFixture();
  await fixture.run();
  const failedBefore = fixture.failures.length;
  await fixture.run({ beforeStatus: async (value) => {
    if (value.state === 'failure') {
      await fixture.run({ context: { eventName: 'issue_comment', runId: 101 } });
      assert.equal(fixture.statuses.at(-1).state, 'success');
    }
  } });
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.failures.length, failedBefore);
});

test('racing unsigned creates leave only the earliest prompt and still allow signing', async () => {
  const fixture = claFixture();
  await fixture.run({ beforeCreateComment: () => fixture.run({ context: { runId: 101 } }) });
  assert.equal(fixture.comments.length, 1);
  assert.equal(fixture.comments[0].id, 5);
  assert.deepEqual(fixture.commentCalls, { list: 4, create: 2, update: 0, delete: 1 });
  await fixture.run({ context: { eventName: 'issue_comment' } });
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.writes.length, 1);
});

test('racing creates refresh the earliest trusted prompt for the current agreement', async () => {
  const fixture = claFixture();
  let currentRun;
  const olderRun = fixture.run({ beforeCreateComment: async () => {
    fixture.setAgreement('revised-sha', revisedAgreement);
    const currentCreate = Promise.withResolvers();
    currentRun = fixture.run({ context: { runId: 101 }, beforeCreateComment: async () => {
      currentCreate.resolve();
      await olderRun;
    } });
    // Both lists were empty. Let the older create finish before issuing the current create.
    await Promise.race([currentCreate.promise, currentRun]);
  } });
  await olderRun;
  await currentRun;

  assert.deepEqual(fixture.comments.map((comment) => comment.id), [5]);
  assert.ok(fixture.comments[0].body.startsWith(`<!-- plaingym-cla:${sha256(revisedAgreement)} -->`));
  assert.ok(fixture.comments[0].body.includes('/blob/revised-sha/CLA.md'));
  assert.deepEqual(fixture.commentCalls, { list: 5, create: 2, update: 1, delete: 1 });
});

test('concurrent CLA writes merge the latest ledger and preserve both signers', async () => {
  const fixture = claFixture({ writeConflicts: 2, branchConflict: true });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.ledger().signatures.map(entry => entry.userId), [99, 100, 42]);
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
});

test('a concurrent signature for the same author is reused without another write', async () => {
  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  const fixture = claFixture({ writeConflicts: 1, concurrentSignatures: [{ userId: 42, claSha256: sha256(text) }] });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.ledger().signatures.length, 1);
});

test('a caught CLA fixture assertion rejects its run even after a failure status', async () => {
  const fixture = claFixture();
  const payload = { pull_request: { number: 2 } };
  await assert.rejects(fixture.run({ context: { payload } }), (error) => {
    assert.ok(error instanceof AssertionError);
    assert.equal(error.actual.issue_number, 2);
    assert.equal(error.expected.issue_number, 1);
    assert.deepEqual(fixture.failures, [error.message]);
    return true;
  });
  assert.equal(fixture.statuses.at(-1).state, 'failure');
});

test('repeated ledger conflicts stop after a bounded retry and fail closed', async () => {
  const fixture = claFixture({ writeConflicts: 5 });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.ledger().signatures.length, 5);
  assert.match(fixture.failures.at(-1), /Ledger changed/);
});

test('signature identity is user ID, never a recycled login', async () => {
  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  const fixture = claFixture({ ledger: { schemaVersion: 1, signatures: [{ userId: 99, login: 'contributor', claSha256: sha256(text) }] } });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
});

test('forged, early, and unrelated signing comments do not grant a signature', async () => {
  for (const [override, signingRunLists] of [
    [{ user: { id: 99, type: 'User' } }, 1],
    [{ updated_at: '2025-01-01T00:00:00Z' }, 2],
    [{ issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/2' }, 1],
    [{ body: phrase + '; require("node:child_process").execSync("untrusted")' }, 1],
  ]) {
    const comment = { id: 10, user: { id: 42, type: 'User' }, body: phrase, updated_at: '2026-01-02T00:00:00Z', issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/1', ...override };
    const fixture = claFixture({ comment });
    await fixture.run();
    fixture.context.eventName = 'issue_comment';
    await fixture.run();
    assert.equal(fixture.statuses.at(-1).state, 'failure');
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.commentCalls.list, 2 + signingRunLists);
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

const coAuthor = { id: 77, login: 'co-author', type: 'User' };
const signedOpener = (text = 'Version 1.0\nPublic fixture contributor agreement.\n') => ({
  schemaVersion: 1, signatures: [{ userId: 42, login: 'contributor', claSha256: sha256(text) }],
});

const openerCommit = { sha: 'opener-commit', author: { id: 42, login: 'contributor', type: 'User' } };
const coAuthorCommit = { sha: 'current-head', author: coAuthor };
const signingComment = (user, updatedAt = '2026-01-02T00:00:00Z') => ({
  id: 10 + user.id, user, body: phrase, updated_at: updatedAt,
  issue_url: 'https://api.github.com/repos/plaingym/plaingym/issues/1',
});
const otherPull = (overrides = {}) => ({
  number: 2, user: { id: 55, login: 'other-opener', type: 'User' }, head: { sha: 'current-head' },
  base: { repo: { full_name: 'plaingym/plaingym' } }, ...overrides,
});

test('a signed opener whose pull request has a commit by an unsigned account is not covered', async () => {
  const fixture = claFixture({ ledger: signedOpener(), commits: [coAuthorCommit] });
  await fixture.run();
  assert.deepEqual(fixture.paginated.slice(0, 1), ['listCommits']);
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.statuses.at(-1).description, 'CLA signature required; see the signing comment');
  assert.equal(fixture.statuses.at(-1).sha, 'current-head');
  assert.equal(fixture.comments.length, 1);
  assert.match(fixture.comments[0].body, /@co-author, please read /);
  assert.doesNotMatch(fixture.comments[0].body, /@contributor/);
  assert.deepEqual(fixture.failures, ['Every contributor to the pull request must sign CLA.md']);
});

test('a commit author signs by comment; a commenter who authored no commit cannot', async () => {
  const fixture = claFixture({ ledger: signedOpener(), commits: [openerCommit, coAuthorCommit] });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';

  fixture.setComment(signingComment({ id: 78, login: 'bystander', type: 'User' }));
  await fixture.run();
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(fixture.ledger().signatures.map((entry) => entry.userId), [42]);
  assert.equal(fixture.statuses.at(-1).state, 'failure');

  fixture.setComment(signingComment(coAuthor));
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.writes[0].message, /user 77$/);
  assert.deepEqual(fixture.ledger().signatures.map((entry) => [entry.userId, entry.login]), [[42, 'contributor'], [77, 'co-author']]);
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.statuses.at(-1).description, 'Contributor agreement signed');
});

test('an unsigned opener and co-author are both prompted, and the prompt follows who is left', async () => {
  const fixture = claFixture({ commits: [coAuthorCommit, openerCommit] });
  await fixture.run();
  assert.equal(fixture.comments.length, 1);
  assert.match(fixture.comments[0].body, /^<!-- plaingym-cla:[0-9a-f]{64} -->\n<!-- plaingym-cla-blob:[^\n]+ -->\n@contributor, @co-author, please read /);

  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.deepEqual(fixture.ledger().signatures.map((entry) => entry.userId), [42]);
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.match(fixture.comments[0].body, /-->\n@co-author, please read /);
  assert.doesNotMatch(fixture.comments[0].body, /@contributor/);
  assert.deepEqual(fixture.commentCalls, { list: 4, create: 1, update: 1, delete: 0 });

  // A signature must follow the prompt's latest revision.
  fixture.setComment(signingComment(coAuthor, '2026-01-04T00:00:00Z'));
  await fixture.run();
  assert.deepEqual(fixture.ledger().signatures.map((entry) => entry.userId), [42, 77]);
  assert.equal(fixture.statuses.at(-1).state, 'success');
});

test('commits with no linked account or by a bot are covered by the signed opener', async () => {
  const fixture = claFixture({ ledger: signedOpener(), commits: [
    { sha: 'unlinked', author: null }, { sha: 'current-head', author: { id: 90, login: 'helper[bot]', type: 'Bot' } },
  ] });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.comments.length, 0);
  assert.deepEqual(fixture.permissionCalls, ['contributor']);
});

test('an exempt opener does not cover an outside commit author, and exempt commit authors never sign', async () => {
  const outside = claFixture({ permission: 'admin', commits: [openerCommit, coAuthorCommit, { ...coAuthorCommit, sha: 'second' }] });
  await outside.run();
  assert.equal(outside.statuses.at(-1).state, 'failure');
  assert.equal(outside.comments.length, 1);
  assert.match(outside.comments[0].body, /-->\n@co-author, please read /);
  assert.deepEqual(outside.permissionCalls, ['contributor', 'co-author']);

  const own = claFixture({ permission: 'admin', commits: [openerCommit] });
  await own.run();
  assert.deepEqual(own.statuses.map((status) => [status.state, status.description]), [
    ['pending', 'Checking contributor agreement'], ['success', 'Maintainer or approved dependency bot'],
  ]);
  assert.equal(own.comments.length, 0);

  const maintainer = { id: 80, login: 'maintainer', type: 'User' };
  const fixture = claFixture({ ledger: signedOpener(), permissions: { maintainer: 'maintain' }, commits: [{ sha: 'current-head', author: maintainer }] });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'success');
  assert.equal(fixture.comments.length, 0);
});

test('another open pull request on the same head commit must be covered before success', async () => {
  const fixture = claFixture({ ledger: signedOpener(), otherPulls: [otherPull()] });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.statuses.at(-1).description, 'Another pull request on this commit needs a CLA signature');
  assert.equal(fixture.statuses.some((status) => status.state === 'success'), false);
  assert.deepEqual(fixture.failures, ['Pull request #2 has the same head commit and its author has not signed CLA.md']);
  assert.equal(fixture.comments.length, 0);

  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  for (const options of [
    { ledger: { schemaVersion: 1, signatures: [...signedOpener().signatures, { userId: 55, claSha256: sha256(text) }] }, otherPulls: [otherPull()] },
    { ledger: signedOpener(), permissions: { 'other-opener': 'admin' }, otherPulls: [otherPull()] },
    { ledger: signedOpener(), otherPulls: [otherPull({ head: { sha: 'other-head' } })] },
    { ledger: signedOpener(), otherPulls: [otherPull({ base: { repo: { full_name: 'someone/fork' } } })] },
  ]) {
    const covered = claFixture(options);
    await covered.run();
    assert.equal(covered.statuses.at(-1).state, 'success');
    assert.deepEqual(covered.failures, []);
  }
});

test('an exempt opener still needs every other pull request on its head commit covered', async () => {
  const fixture = claFixture({ permission: 'admin', otherPulls: [otherPull()] });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).description, 'Another pull request on this commit needs a CLA signature');
  assert.equal(fixture.comments.length, 0);

  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  const covered = claFixture({ permission: 'admin', otherPulls: [otherPull()], ledger: { schemaVersion: 1, signatures: [{ userId: 55, claSha256: sha256(text) }] } });
  await covered.run();
  assert.equal(covered.statuses.at(-1).state, 'success');
  assert.equal(covered.statuses.at(-1).description, 'Maintainer or approved dependency bot');
});

test('a pull request with more than 250 commits needs a maintainer', async () => {
  const fixture = claFixture({ ledger: signedOpener(), pr: { commits: 251 } });
  await fixture.run();
  assert.equal(fixture.statuses.at(-1).state, 'failure');
  assert.equal(fixture.statuses.at(-1).description, 'CLA check needs maintainer attention');
  assert.deepEqual(fixture.failures, ['Too many commits to check the contributor agreement']);
  assert.equal(fixture.paginated.includes('listCommits'), false);
});

test('two signers signing at once both stay in the ledger', async () => {
  const text = 'Version 1.0\nPublic fixture contributor agreement.\n';
  const fixture = claFixture({ commits: [openerCommit, coAuthorCommit], writeConflicts: 1, concurrentSignatures: [{ userId: 77, login: 'co-author', claSha256: sha256(text) }] });
  await fixture.run();
  fixture.context.eventName = 'issue_comment';
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.ledger().signatures.map((entry) => entry.userId), [77, 42]);
  assert.equal(fixture.statuses.at(-1).state, 'success');
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
  assert.equal(fixture.failures.at(-1), 'Write unavailable');
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
