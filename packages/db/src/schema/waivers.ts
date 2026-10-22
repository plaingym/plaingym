// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { base, choice, instant, ref, scoped } from './common.js';
import { members } from './members.js';
export const waiverTemplates = pgTable('waiver_templates', {
  ...base(), name: text('name').notNull(), kind: text('kind').notNull().default('waiver'),
  version: integer('version').notNull(), body: text('body').notNull(),
}, (t) => [...scoped('waiver_templates', t), unique('waiver_templates_version_key').on(t.gymId, t.name, t.version),
  choice('waiver_templates_kind_check', t.kind, ['waiver', 'agreement']),
  check('waiver_templates_version_check', sql`${t.version} > 0`)]).enableRLS();
export const waiverSignatures = pgTable('waiver_signatures', {
  ...base(), memberId: uuid('member_id').notNull(), templateId: uuid('template_id').notNull(),
  snapshot: text('snapshot').notNull(), snapshotHash: text('snapshot_hash').notNull(),
  signatureImageKey: text('signature_image_key').notNull(), signatureImageHash: text('signature_image_hash').notNull(),
  signedAt: instant('signed_at').notNull(), ipAddress: text('ip_address').notNull(),
}, (t) => [...scoped('waiver_signatures', t), ref('waiver_signatures_member_fk', t.gymId, t.memberId, members),
  ref('waiver_signatures_template_fk', t.gymId, t.templateId, waiverTemplates),
  check('waiver_signatures_hash_check', sql`${t.snapshotHash} ~ '^[a-f0-9]{64}$' and ${t.signatureImageHash} ~ '^[a-f0-9]{64}$'`),
]).enableRLS();
