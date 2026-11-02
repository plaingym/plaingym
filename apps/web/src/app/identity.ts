// SPDX-License-Identifier: AGPL-3.0-only
import type { ShellSession } from '@plaingym/shared/contracts';
import { t } from '../lib/i18n.js';

/** The name the signed-in person is shown by; a session the server could not name gets a generic label, never an ID. */
export const sessionName = (session: Pick<ShellSession, 'displayName'>) => session.displayName ?? t('shell/shell:signedIn');
