// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, type ReactNode } from 'react';
import { t } from '../../lib/i18n.js';

/** Let a registered step include the wizard's secondary action in its own bar. */
export const SetupSecondaryActions = createContext<ReactNode>(null);

/** Keep the current step's actions in reach while its fields scroll. */
export function SetupActions({ children }: { children: ReactNode }) {
  const secondary = useContext(SetupSecondaryActions);
  return <div role="group" aria-label={t('setup/setup:actions')} className="sticky bottom-0 z-10 grid gap-2 border-t border-border bg-card pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex sm:flex-wrap [&>button]:w-full sm:[&>button]:w-auto">{children}{secondary}</div>;
}
