// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock, MemberScope, SignedLink, StaffRole } from '@plaingym/shared';

export interface GymContext {
  readonly gymId: string;
  readonly timezone: string;
  readonly enabledModules: ReadonlySet<string>;
}

export type Principal =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'staff';
      readonly userId: string;
      readonly gymId: string;
      readonly roles: readonly StaffRole[];
    }
  | { readonly kind: 'member'; readonly userId: string; readonly scope: MemberScope }
  | { readonly kind: 'kiosk'; readonly gymId: string; readonly deviceId: string }
  | {
      readonly kind: 'signed_link';
      readonly gymId: string;
      readonly linkId: string;
      /** Display and routing metadata; authorization reloads the link by gymId and linkId. */
      readonly householdId: string;
      readonly link: SignedLink;
    };

export interface RequestContext {
  readonly requestId: string;
  readonly gym: GymContext;
  readonly principal: Principal;
  readonly clock: Clock;
}

export interface RequestEnvironment {
  Variables: { context: RequestContext };
}
