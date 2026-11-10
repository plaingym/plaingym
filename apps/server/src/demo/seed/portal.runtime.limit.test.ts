// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { members, plans, waiverTemplates } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { useSandboxRuntime } from './portal.runtime.fixture.test-helper.js';
import { clock } from '../../core/clock.js';
import { demoSignatureLimit, reserveDemoSignature } from '../waiver-signatures.js';
import { demoPlans } from './billing.js';
import { demoSignaturePng } from './waivers-image.js';

const db = useTestDatabase();
const app = useSandboxRuntime(db, 1);

it('refuses a join once the sandbox has used its signature-image admissions', async () => {
  const other = app.sandbox;
  const [plan] = await db.forGym(other.gymId, tx => tx.select().from(plans).where(eq(plans.name, demoPlans[0].name)));
  const [template] = await db.forGym(other.gymId, tx => tx.select().from(waiverTemplates));
  const [anyone] = await db.forGym(other.gymId, tx => tx.select().from(members).limit(1));
  for (let used = 0; used < demoSignatureLimit; used++)
    await reserveDemoSignature(db.forGym, { gymId: other.gymId, actor: { kind: 'system' } }, anyone!.id, clock.now());
  const person = { firstName: 'Limit', lastName: 'Visitor', dateOfBirth: '1994-05-06' };
  const admission = await app.send(other.origin, '/join/signatures', { body: { planId: plan!.id, contact: { name: 'Limit Visitor', email: 'limit@example.invalid' },
    honeypot: '', members: [{ member: person, signatures: [{ templateId: template!.id, templateVersion: template!.version, pngBase64: demoSignaturePng().toString('base64'), signer: { kind: 'self', name: 'Limit Visitor' } }] }] } });
  expect(admission.status).toBe(429);
  expect(await admission.json()).toMatchObject({ error: { code: 'rate_limited' } });
}, 60_000);
