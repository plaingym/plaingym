// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const source = (file: string) => readFileSync(resolve(root, 'apps/server/src', file), 'utf8');

/** Each production boundary is deliberately classified. New outbound call sites require review. */
const boundaries = {
  'areas/bookings/bookings.delivery.ts': 'memberEmailsEnabled and recipient preferences reloaded by MemberEmail immediately before gym SMTP delivery',
  'areas/billing/runner/index.ts': 'billingEnabled: before reservation, create and confirm',
  'areas/billing/signed-link-checkout.ts': 'billingEnabled before payment preparation and delivery; setup is allowed while paused',
  'areas/billing/customers.ts': 'customer creation is preparatory, allowed while billing is paused',
  'areas/billing/transitions/notifications.ts': 'memberEmailsEnabled at recipient selection and immediately before sending; staff notices are exempt',
  'areas/billing/alerts/index.ts': 'memberEmailsEnabled: card expiry; owner disputes are exempt',
  'areas/links/service.delivery.ts': 'memberEmailsEnabled reloaded from persisted settings immediately before delivery',
  'infra/email/member.ts': 'memberEmailsEnabled: member-targeted email adapter',
  'infra/email/deliveries.ts': 'keyed send state around a transport its callers chose; each caller above checks its own switch',
  'infra/email/smtp.ts': 'administrative SMTP test, delivery transport guarded by its member callers',
  'infra/auth/delivery.ts': 'security: requested login links are exempt',
  'areas/staff/profiles.invitations.ts': 'staff invitations are exempt',
  'areas/members/household-users.invitations.ts': 'staff-initiated portal invitations use the gym SMTP mailer outside the transaction',
  'public/pages/notifications.ts': 'staff-only owner/admin runtime recipients are exempt; visitor confirmations require memberEmailsEnabled',
  'demo/runtime.ts': 'security: sandbox login links use the demo outbox',
};

// Routes and job callbacks share the boundary above; keep each entry path explicit.
const chargePaths = [
  ['daily membership collection and catch-up', 'areas/billing/runner/runner.test.ts', 'does nothing with billing disabled'],
  ['queued dunning retries', 'areas/billing/runner/runner.test.ts', 'including direct charges and retry callbacks'],
  ['staff invoice and one-off saved-card charges', 'areas/billing/runner/runner.test.ts', 'allows an audited staff charge'],
  ['assignment proration and sign-up fees', 'areas/billing/runner/runner.test.ts', 'collects assignment proration and sign-up fees'],
  ['zero-value settlement', 'areas/billing/runner/runner.test.ts', 'zero settlement respects enablement'],
  ['signed pay links: cycle, assignment and one-off Checkout', 'areas/settings/go-live.switches.test.ts', 'paused billing must refuse'],
  ['pay-link customer creation and cycle/assignment card saving', 'areas/billing/customers.links.test.ts', 'saves its card through the webhook'],
  ['card and onboarding setup, customer creation, no charge', 'areas/settings/go-live.switches.test.ts', 'card setup with billing off'],
  ['existing Checkout/PaymentIntent completion while paused', 'areas/billing/runner/runner.test.ts', 'including with billing off'],
  ['restore and unknown-outcome reconciliation, no new charges', 'areas/billing/runner/runner.test.ts', 'keeps unmatched payments paused'],
  ['cash/check accounting and refunds, no new card charges', 'areas/billing/transitions/transitions.test.ts', 'records manual payments idempotently'],
] as const;
const emailPaths = [
  ['member-targeted mail', 'infra/email/member.test.ts', 'reloads changed switches'],
  ['receipt/resend and dunning/SCA messages', 'areas/billing/transitions/transitions.test.ts', 'suppresses disabled/opted-out payer email'],
  ['signed pay, card, waiver and onboarding links', 'areas/links/service.test.ts', 'memberEmailsEnabled: false'],
  ['card expiry and queued delivery', 'areas/billing/alerts/alerts.test.ts', 'revokes an undisclosed link after suppression'],
  ['staff/security mail and owner disputes', 'infra/email/member.test.ts', 'keeps staff/security mail available'],
  ['public intake notices with staff-only runtime recipients', 'public/pages/pages.test.ts', 'keeps new, existing and enrolled emails indistinguishable without editing existing households'],
  ['runtime public intake staff recipients', 'core/runtime.public-pages.test.ts', 'sends public intake notices only to owner/admin staff even with member emails disabled'],
] as const;

describe('go-live switch test inventory', () => {
  it('classifies every production charge/customer/Checkout and email send boundary', () => {
    const found = globSync('apps/server/src/**/*.ts', { cwd: root, exclude: ['**/*.test.ts', '**/infra/payments/**'] })
      .map(file => file.replaceAll('\\', '/').replace('apps/server/src/', ''))
      .filter(file => file !== 'core/registry-infra-contracts.ts')
      .filter(file => /\.(?:createCharge|confirmCharge|createCheckout|createCustomer|sendEmail)\s*\(|\bdeliveries\.send\s*\(/.test(source(file)));
    expect(found.sort()).toEqual(Object.keys(boundaries).sort());
    expect(Object.values(boundaries).every(reason => reason.length > 20)).toBe(true);
  });
  it.each([...chargePaths, ...emailPaths])('tracks %s with executable regression coverage', (_path, file, evidence) => {
    expect(source(file)).toContain(evidence);
  });
});
