// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import messages from '../../../../../locales/en/waivers/validation.json' with { type: 'json' };
const t = createTranslator({ 'waivers/validation': messages });
export const waiverValidation = (key: Exclude<keyof typeof messages, '$comment'>, values?: Record<string, string | number>) => t('waivers/validation:' + key, values);
