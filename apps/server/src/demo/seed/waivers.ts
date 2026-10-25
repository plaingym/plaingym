// SPDX-License-Identifier: AGPL-3.0-only
import type { SeedStep } from './index.js';
import { findDemoMembers } from './members.js';
import { demoSignaturePng } from './waivers-image.js';
import { createMembersService } from '../../areas/members/members.js';
import { createWaiversService, type WaiverOptions } from '../../areas/waivers/waivers.js';

/** Inject a seed-only Uploads provider: request-facing demo uploads stay disabled. */
export function waiversSeed(options: WaiverOptions): SeedStep {
  return { id: 'waivers', async run(context) {
    const service = createWaiversService(options), members = createMembersService({ ...(options.scope ? { scope: options.scope } : {}), ...(options.clock ? { clock: options.clock } : {}) });
    const actor = { gymId: context.gymId, actor: { kind: 'system' as const } };
    const name = 'Demo participation waiver';
    let template = (await service.listTemplates(context.gymId, { limit: 100, includeRetired: 'true' })).data.find(row => row.name === name);
    template ??= await service.createTemplate(actor, { name, kind: 'waiver', body: 'Sample waiver for the demo gym. Training involves physical activity. Follow your instructor’s directions and tell them about injuries before class. This fictional sample demonstrates signing and is not a waiver for a real gym.' });
    const people = await findDemoMembers(members, context.gymId);
    // Adults and one child are signed; the remaining seeded members are unsigned.
    for (const [memberName, signer] of [
      ['Marcus Rivera', { kind: 'self', name: 'Marcus Rivera' }],
      ['Ava Chen', { kind: 'guardian', name: 'Daniel Chen', relationship: 'Parent' }],
      ['Elena Petrova', { kind: 'self', name: 'Elena Petrova' }],
    ] as const) {
      const member = people.get(memberName); if (!member) continue;
      const existing = await service.listSignatures(context.gymId, { memberId: member.id, templateId: template.id });
      if (existing.pagination.total) continue;
      const uploaded = await service.uploadSignature(actor, member.id, demoSignaturePng());
      await service.sign(actor, { memberId: member.id, templateId: template.id, templateVersion: template.version, signer, ...uploaded, consent: true }, { timezone: context.timezone, ipAddress: 'demo-seed' });
    }
  } };
}
