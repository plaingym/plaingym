// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';
import { t } from '../../../lib/i18n.js';
export const text: Translator = (key, values) => t('billing/payments:' + key, values);
export { amountInputPattern, money, minorUnitsToInput, parseMinorUnits } from '../catalog/format.js';
