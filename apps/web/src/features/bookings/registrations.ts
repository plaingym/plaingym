// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../lib/registries.js';
import { BookingRosterPanel, MemberBookingsPanel } from './panels.js';

export const registration: WebRegistration = {
  memberTabs: [
    {
      id: 'memberTabs.bookings',
      labelKey: 'bookings/bookings:title',
      permission: { kind: 'staff', capability: 'bookings.manage' },
      enabled: true,
      component: MemberBookingsPanel,
    },
  ],
  sessionPanels: [
    {
      id: 'sessionPanels.bookings',
      labelKey: 'bookings/bookings:title',
      permission: { kind: 'staff', capability: 'bookings.manage' },
      enabled: true,
      component: BookingRosterPanel,
    },
  ],
};
