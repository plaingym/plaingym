// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configuration, provision, checked, sql } from '../vm/host.js';
import { api, browserFor, guards, wizard, restoreWizard, verifyRestored, login, owner, type Witness } from '../vm/browser.js';
import { startMemory, endMemory, backupLoad, argonLoad, prepareArgon } from '../vm/memory.js';

test('fresh VM → private link → browser wizard → scheduled backup → second VM browser restore → memory and Argon2id', async ({ playwright }) => {
  test.setTimeout(3_600_000);
  const config = await configuration();
  const phase = process.env.E2E_VM_PHASE ?? 'all';
  const findings: string[] = [];
  if(config.localSnapshotRetry) findings.push('QA-RETRY: local recovery uses a fresh key/bucket and a QA-triggered snapshot after a harness interruption; it is not unassisted acceptance');
  const record = async () => writeFile(resolve(config.artifacts, 'findings.json'), JSON.stringify(findings, null, 2));
  const witnessFile = resolve(config.artifacts, 'witness.json');
  const localInstalls = config.localFixture && phase === 'all'
    ? await test.step('install the two isolated local guests concurrently', () => Promise.all([
      provision(config, config.source, 'source'), provision(config, config.restore, 'restore'),
    ])) : null;
  let witness: Witness;
  if(phase !== 'restore') {
    const source = localInstalls?.[0] ?? await test.step('one command installs from the maintainer bundle on a clean host', () => provision(config, config.source, 'source'));
    findings.push(...source.findings);
    await record();
    const primary = await browserFor(playwright.chromium, config, config.source);
    try {
      const completedWitness = config.resume && await readFile(witnessFile).then(() => true, () => false);
      if(!completedWitness) await test.step('unprivileged setup mutations and restore polling require the private link', () => guards(primary.context, config.source));
      witness = await test.step('all gym setup, backup key confirmation, import and upload happen in the browser', async () => {
        if(config.resume) {
          try { return JSON.parse(await readFile(witnessFile, 'utf8')) as Witness; }
          catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const values = await wizard(primary.page, config, source.setupLink);
        if(config.localSnapshotRetry) {
          await readFile(resolve(config.artifacts, 'scheduled-backup-verified.json'), 'utf8');
          await backupLoad(config.source, config.artifacts);
        }
        // Wait for the real scheduler. Do not kick a job, restart the app, edit the
        // clock, or substitute a maintenance snapshot for this acceptance step.
        let snapshotId = '';
        await expect.poll(async () => {
          snapshotId = await checked(config.source, sql("SELECT id FROM backup_runs WHERE status='succeeded' ORDER BY started_at DESC LIMIT 1"));
          return snapshotId;
        }, { timeout: 180_000, intervals: [2000] }).toMatch(/^[a-f0-9-]{36}$/);
        const result = { ...values, snapshotId };
        await writeFile(witnessFile, JSON.stringify(result, null, 2), { mode: 0o600 });
        await primary.page.goto(config.source.url + '/admin/health');
        await expect(primary.page.getByText('The latest completed snapshot is available for restore.', { exact: true })).toBeVisible();
        await writeFile(resolve(config.artifacts, 'source-verified.json'), JSON.stringify({ wizard: true, snapshotRetry: Boolean(config.localSnapshotRetry), restoredSnapshotKind: config.localSnapshotRetry ? 'manual-QA-retry' : 'scheduled', scheduledBackup: true, import: true, photoUpload: true }));
        return result;
      });
    } finally { await primary.browser.close(); }
  } else witness = JSON.parse(await readFile(witnessFile, 'utf8')) as Witness;
  if(phase === 'source') {
    expect(findings, 'See findings.json; switch DNS only after this source phase finishes').toEqual([]);
    return;
  }
  const installed = localInstalls?.[1] ?? await test.step('second clean host gets its own private setup link', () => provision(config, config.restore, 'restore'));
  findings.push(...installed.findings.map((finding) => 'restore: ' + finding));
  await record();
  const secondary = await browserFor(playwright.chromium, config, config.restore);
  let sampling = false;
  let argonModule: Awaited<ReturnType<typeof prepareArgon>>;
  try {
    await test.step('restore is driven entirely from the second installer’s private web link', async () => {
      const verified = config.resume && await readFile(resolve(config.artifacts, 'restore-verified.json')).then(() => true, () => false);
      if(!verified) await guards(secondary.context, config.restore);
      argonModule = await prepareArgon(config.restore);
      await startMemory(config.restore); sampling = true;
      if(verified) { await login(secondary.page, config.restore.url); await verifyRestored(secondary.page, config, witness); }
      else await restoreWizard(secondary.page, config, installed.setupLink, witness);
      await writeFile(resolve(config.artifacts, 'restore-verified.json'), JSON.stringify({ wizardRestore: true, ownerLogin: true, member: true, exactPhotoBytes: true, billingPaused: true }));
    });
    await test.step('deployed Argon2id adapter, API load and encrypted backup run under production caps', async () => {
      const format = await checked(config.restore, sql("SELECT count(*) > 0 AND bool_and(password LIKE '$argon2id$v=19$m=19456,t=2,p=1$%') FROM auth_account WHERE provider_id='credential'"));
      expect(format).toBe('t');
      // A measured quiet window separates warm idle from the concurrent load.
      await secondary.page.waitForTimeout(10_000);
      const busyStart = Number(await checked(config.restore, 'date +%s'));
      const started = Date.now();
      const workload = await Promise.all([
        backupLoad(config.restore, config.artifacts),
        argonLoad(config.restore, argonModule),
        secondary.page.evaluate(async (account) => {
          const latencies = await Promise.all(Array.from({ length: 20 }, async () => {
            const start = performance.now();
            const response = await fetch('/api/members?limit=20');
            if(response.status !== 200) throw new Error('Concurrent API read failed: ' + response.status);
            return performance.now() - start;
          }));
          const normalized = await fetch('/api/auth/sign-in/email', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: account.email, password: account.password.normalize('NFKD') })
          });
          const wrong = await fetch('/api/auth/sign-in/email', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: account.email, password: 'wrong-password-for-vm-qa' })
          });
          return { latencies, normalizedStatus: normalized.status, wrongStatus: wrong.status };
        }, owner),
      ]);
      expect(workload[2].normalizedStatus).toBe(200);
      expect(workload[2].wrongStatus).toBe(401);
      await writeFile(resolve(config.artifacts, 'argon2id.json'), JSON.stringify({
        elapsedMs: Date.now() - started,
        adapter: workload[1], http: workload[2], backup: workload[0],
        overlapMs: Math.max(0, Math.min(workload[0].completedAt, workload[1].completedAt) - Math.max(workload[0].startedAt, workload[1].startedAt))
      }, null, 2));
      const switches = await api<{ data: { billingEnabled: boolean } }>(secondary.page, '/api/settings/go-live');
      expect(switches.data.billingEnabled).toBe(false);
      const memory = await endMemory(config.restore, config, busyStart); sampling = false;
      findings.push(...memory.violations.map((finding) => 'MEMORY: ' + finding));
      await record();
    });
  } finally {
    if(sampling) await endMemory(config.restore, config);
    await secondary.browser.close();
  }
  // Product acceptance stays red for gaps; recording them never converts a
  // missing one-command/web-only requirement into an expected pass.
  expect(findings, 'Product gaps are recorded in the private findings.json and the task handoff').toEqual([]);
});
