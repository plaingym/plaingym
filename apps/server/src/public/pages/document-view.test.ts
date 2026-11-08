// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { joinFormPage } from './join.page.js';
import { intakePage } from './page.js';
import { linkPage } from '../links/page.js';

const t = createTranslator({ ...locales.en, 'waivers/waivers': { ...locales.en?.['waivers/waivers'], openDocument: 'Translated document link' } });
const gym = { name: 'Academy', revision: 1, logoKey: null, primaryColor: null };
const now = new Date('2026-11-07T12:00:00Z');
const templates = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `Terms ${i}`, version: 1, kind: 'waiver' as const, body: '', retiredAt: null, createdAt: now.toISOString(),
  document: { key: `gym/waivers/templates/${i}.pdf`, hash: 'c'.repeat(64), pages: 1, bytes: 1000 } }));
const plan = { id: 'plan', name: 'Training', amountCents: 10000, currency: 'USD', interval: 'monthly' as const, plusTax: false, signupFeeCents: 0, trialDays: 0, commitmentMonths: null, revision: 1 };
it('previews each document once for a six-member, eight-template family and keeps separate explicit consent', () => {
  const html = joinFormPage({ gym, t, plan, count: 6, templates });
  expect(html.match(/<iframe /g)).toHaveLength(8);
  expect(html.match(/Translated document link/g)).toHaveLength(48);
  expect(html.match(/type="checkbox"[^>]*required/g)).toHaveLength(48);
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toContain('If it will not open, contact the gym before signing');
});
it('uses the request translator for drop-in and signed-link documents and deduplicates onboarding previews', () => {
  expect(intakePage({ kind: 'drop-in', gym, t, templates, dropInFee: null })).toContain('Translated document link');
  const html = linkPage({ now, timezone: 'UTC', t, data: { purpose: 'onboarding', templates, signatures: [], paymentMethods: [],
    members: Array.from({ length: 6 }, (_, i) => ({ id: String(i), firstName: 'Alex', lastName: 'Example', dateOfBirth: '1990-01-01', revision: 1 })) } });
  expect(html.match(/<iframe /g)).toHaveLength(8);
  expect(html.match(/Translated document link/g)).toHaveLength(48);
});
