// SPDX-License-Identifier: AGPL-3.0-only
import { formatMinorUnits } from '@plaingym/shared/money';

/** An amount in `currency`'s minor units, in the given locale. Each caller keeps its own locale. */
export const formatMoney = (amount: number, currency: string, locale = 'en') => formatMinorUnits(amount, currency, locale);
