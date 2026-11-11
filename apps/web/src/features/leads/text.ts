// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../lib/i18n.js';

export const text = (key: string, values?: Record<string, string | number>) => t('leads/screens:' + key, values);
