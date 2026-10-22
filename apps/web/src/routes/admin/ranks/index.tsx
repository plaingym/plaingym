// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from '@tanstack/react-router';
import { RanksPage } from '../../../features/ranks/page.js';

export const Route = createFileRoute('/admin/ranks/')({ component: RanksPage });
