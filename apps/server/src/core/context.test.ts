// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expectTypeOf, it } from 'vitest';
import type { RoutePermission, SignedLink, SignedLinkPurpose } from '@plaingym/shared';
import type { Principal } from './context.js';

type LinkPrincipal = Extract<Principal, { kind: 'signed_link' }>;

describe('signed-link principal contract', () => {
  it('requires a link identity without requiring a user identity', () => {
    expectTypeOf<LinkPrincipal>().toEqualTypeOf<{
      readonly kind: 'signed_link';
      readonly gymId: string;
      readonly linkId: string;
      readonly householdId: string;
      readonly link: SignedLink;
    }>();
    expectTypeOf<Omit<LinkPrincipal, 'linkId'>>().not.toMatchTypeOf<LinkPrincipal>();
  });

  it('ties invoice and waiver purposes to their resource identifiers', () => {
    expectTypeOf<{ purpose: 'pay_invoice'; invoiceId: string }>().toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: 'sign_waiver'; memberId: string }>().toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: 'pay_invoice' }>().not.toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: 'sign_waiver' }>().not.toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: 'pay_invoice'; memberId: string }>().not.toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: 'sign_waiver'; invoiceId: string }>().not.toMatchTypeOf<SignedLink>();
    expectTypeOf<{ purpose: string; resourceId: string }>().not.toMatchTypeOf<SignedLink>();
  });

  it('shares the route purpose union and keeps household purposes resource-free', () => {
    expectTypeOf<SignedLink['purpose']>().toEqualTypeOf<SignedLinkPurpose>();
    expectTypeOf<
      Extract<RoutePermission, { kind: 'signed_link' }>['purpose']
    >().toEqualTypeOf<SignedLinkPurpose>();
    expectTypeOf<Extract<SignedLink, { purpose: 'update_card' }>>().toEqualTypeOf<{
      readonly purpose: 'update_card';
    }>();
    expectTypeOf<Extract<SignedLink, { purpose: 'onboarding' }>>().toEqualTypeOf<{
      readonly purpose: 'onboarding';
    }>();
  });
});
