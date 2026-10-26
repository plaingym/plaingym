// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../../lib/i18n.js';
export const text = (key: string) => t('billing/payments:' + key);
export { money, decimalUnits, decimalAmount } from '../catalog/format.js';
