// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentType } from 'react';
import { createWebRegistries, type WebContribution } from '@plaingym/shared';
import { registration as part0 } from '../features/settings/general/registrations.js';
import { registration as part1 } from '../features/kiosk-devices/registrations.js';
import { registration as part2 } from '../features/settings/go-live.registrations.js';
import { registration as part3 } from '../features/settings/updates.registrations.js';
import { registration as part4 } from '../features/settings/auth.registrations.js';
import { registration as part5 } from '../features/health/registrations.js';
import { registration as part6 } from '../features/setup/registrations.js';
import { registration as part7 } from '../features/setup/import-step.registrations.js';
import { registration as part8 } from '../features/setup/stripe-step.registrations.js';
import { registration as part9 } from '../features/demo/registrations.js';
import { registration as part10 } from '../features/demo/landing.registrations.js';
import { registration as part11 } from '../features/members/registrations.js';
import { registration as part12 } from '../features/staff/registrations.js';
import { registration as part13 } from '../features/ranks/registrations.js';
import { registration as part14 } from '../features/schedule/registrations.js';
import { registration as part15 } from '../features/attendance/registrations.js';
import { registration as part16 } from '../features/imports/registrations.js';
import { registration as part17 } from '../features/kiosk/registrations.js';
import { registration as part18 } from '../features/kiosk/qr.registrations.js';
import { registration as part19 } from '../features/dashboard/registrations.js';
import { registration as part20 } from '../features/dashboard/billing.registrations.js';
import { registration as part21 } from '../features/billing/catalog/registrations.js';
import { registration as part22 } from '../features/billing/memberships/registrations.js';
import { registration as part23 } from '../features/billing/invoices/registrations.js';
import { registration as part24 } from '../features/waivers/registrations.js';
import { registration as part25 } from '../features/campaigns/registrations.js';
import { registration as part26 } from '../features/bookings/registrations.js';
import { registration as part27 } from '../features/portal/access/registrations.js';
import { registration as part28 } from '../features/portal/shell/registrations.js';
import { registration as part29 } from '../features/portal/schedule/registrations.js';
import { registration as part30 } from '../features/portal/checkin/registrations.js';
import { registration as part31 } from '../features/portal/progress/registrations.js';
import { registration as part32 } from '../features/portal/billing/registrations.js';
import { registration as part33 } from '../features/portal/waivers/registrations.js';
import { registration as part34 } from '../features/portal/household/registrations.js';
import { registration as part35 } from '../features/website/registrations.js';
import { registration as part36 } from '../features/settings/billing.registrations.js';

export interface ExtensionViewProps {
  memberId?: string;
  sessionId?: string;
}
export type ExtensionView = ComponentType<ExtensionViewProps>;
export type WebRegistration = WebContribution<ExtensionView>;
export const webContributions: readonly WebRegistration[] = [
  part0,
  part1,
  part2,
  part3,
  part4,
  part5,
  part6,
  part7,
  part8,
  part9,
  part10,
  part11,
  part12,
  part13,
  part14,
  part15,
  part16,
  part17,
  part18,
  part19,
  part20,
  part21,
  part22,
  part23,
  part24,
  part25,
  part26,
  part27,
  part28,
  part29,
  part30,
  part31,
  part32,
  part33,
  part34,
  part35,
  part36,
];
export function createRegistries(additional: readonly WebRegistration[] = []) {
  return createWebRegistries([...webContributions, ...additional]);
}
