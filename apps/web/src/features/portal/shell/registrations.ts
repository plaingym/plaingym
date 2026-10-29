// SPDX-License-Identifier: AGPL-3.0-only
import type { WebRegistration } from '../../../lib/registries.js';

export const registration: WebRegistration = { portalNav: [{ id: 'portalNav.home', labelKey: 'portal/shell:home', href: '/portal', permission: { kind: 'member', capability: 'profile.read' }, enabled: true, order: -100 }] };
