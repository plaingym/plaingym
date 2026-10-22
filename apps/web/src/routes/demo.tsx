// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { t } from '../lib/i18n.js';
export const Route = createFileRoute('/demo')({ component: () => <main id="main-content" className="p-6"><h1>{t('demo/demo:try')}</h1></main> });
