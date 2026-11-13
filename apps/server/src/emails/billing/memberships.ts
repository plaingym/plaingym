// SPDX-License-Identifier: AGPL-3.0-only
import type { EmailTemplate } from '../../core/registry.js';
import { priceChangeEmailSchema, renderPriceChangeNotice } from './price-change.js';

export const templates: readonly EmailTemplate[] = [{ id: 'billing.memberships.price_notice',
  render: async data => renderPriceChangeNotice(priceChangeEmailSchema.parse(data)),
}];
