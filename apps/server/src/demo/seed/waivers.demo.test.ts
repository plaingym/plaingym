// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { staffRoles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { waiverContracts } from '@plaingym/shared/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createRuntimeUploads } from '../../infra/storage/runtime.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { createDemoService } from '../service.js';
import { createDemoIdentities } from '../identities.js';
import { createSeeds, runSeeds } from './index.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { configureWaivers } from '../../areas/waivers/waivers.routes.js';
import { demoSignaturePng } from './waivers-image.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
const db = useTestDatabase();
it('fully seeds a demo sandbox, serves its PDFs, blocks visitor images and runs the real seed CLI', async () => {
  const s3 = await s3Server(), key = parseEncryptionKey('cd'.repeat(32)), clock = new TestClock('2026-10-24T12:00:00Z');
  const env = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test', APP_ENCRYPTION_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'demo-waivers-test-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off',
    UPLOADS_S3_BUCKET: 'waivers', UPLOADS_S3_ENDPOINT: s3.endpoint, UPLOADS_S3_REGION: 'us-east-1',
    UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' };
  const uploads = createRuntimeUploads(env, key, async () => 'https://demo.example.test');
  try {
    const config = { enabled: true, domain: env.DEMO_DOMAIN, maxSandboxes: 50 }, authentication = authConfig(env, true);
    const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope: db.forGym,
      accounts: createAccountService(authentication, () => db.system.db), authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
    const steps = createSeeds({ scope: db.forGym, clock, uploadsFor: uploads.forSeed, pinSecret: null });
    expect(steps.map(step => step.id).slice(0, 5)).toEqual(['foundation', 'members', 'billing', 'waivers', 'mat']);
    const demo = createDemoService({ config, key, clock, scope: db.forGym, system: db.forSystem, identities,
      seed: context => runSeeds(context, steps),
      deletion: createGymDeleteService({ clock, scope: db.forGym, system: db.forSystem, removeUploads: uploads.removeGym }) });
    const sandbox = await demo.create(), gymId = sandbox.gymId;
    const service = configureWaivers({ scope: db.forGym, clock, uploadsFor: uploads.forGym });
    const copies = await service.listSignatures(gymId);
    expect(copies.pagination.total).toBe(3); expect((await service.listTemplates(gymId)).pagination.total).toBe(1);
    const [owner] = await db.forGym(gymId, tx => tx.select().from(staffRoles).where(eq(staffRoles.role, 'owner')));
    const app = createApp({ clock, origin: sandbox.origin, skipSetup: true, authorize, contributions: areaContributions,
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId, userId: owner!.userId, roles: ['owner'] } }); await next(); },
    });
    const copy = copies.data[0]!;
    const result = await app.request(sandbox.origin + '/api/waivers/signatures/' + copy.id + '/pdf');
    expect(result.status, await result.clone().text()).toBe(200);
    const link = waiverContracts.pdf.response.parse(await result.json()).data.url;
    const download = await fetch(link); expect(download.status).toBe(200);
    const task = getDocument({ data: new Uint8Array(await download.arrayBuffer()), useSystemFonts: false });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      expect(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')).toContain(copy.snapshotHash);
    } finally { await task.destroy(); }
    const denied = await app.request(sandbox.origin + '/api/waivers/signature-images', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: sandbox.origin },
      body: JSON.stringify({ memberId: copy.memberId, pngBase64: Buffer.from(demoSignaturePng()).toString('base64') }) });
    expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { message: 'Uploads are disabled in the demo' } });
    const guarded = await uploads.forGym(gymId), pdf = `${gymId}/waivers/${copy.memberId}/pdf/${uuidv7()}.pdf`;
    for (const [path, type] of [[pdf, 'image/png'], [pdf.replace('.pdf', '.png'), 'application/pdf'],
      [pdf.replace('/pdf/', '/signatures/'), 'application/pdf'], [pdf.replace(/\/[^/]+\.pdf$/, '/arbitrary.pdf'), 'application/pdf']]) {
      await expect(guarded.put(path!, new Uint8Array([1]), type!)).rejects.toMatchObject({ code: 'forbidden' });
    }
    // Async child execution lets the loopback S3 fixture serve the CLI's real SDK.
    const cli = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/index.ts', 'seed', gymId], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), windowsHide: true, timeout: 60_000,
      env: { ...process.env, ...env, DATABASE_URL: db.appUrl, DATABASE_POOL_MAX: '2' },
    });
    expect(cli.stdout).toContain('Seed complete');
    expect((await createWaiversService({ scope: db.forGym, clock, uploadsFor: uploads.forGym }).listSignatures(gymId)).pagination.total).toBe(3);
  } finally { uploads.close(); await s3.close(); }
}, 90_000);
