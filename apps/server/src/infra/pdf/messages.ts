// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import messages from '../../../../../locales/en/pdf/pdf.json' with { type: 'json' };
const t = createTranslator({ 'pdf/pdf': messages });
export const pdfText = (key: Exclude<keyof typeof messages, '$comment'>) => t('pdf/pdf:' + key);
