// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { LoadingState } from '../../../components/ui/states.js';
import { t } from '../../../lib/i18n.js';
import { clearPortalRecoveryNotice, usePortalLogin, usePortalRecoveryNotice } from './api.js';

/** Native modal dialogs escape ancestor hiding, so hide those too without destroying their drafts or canvas. */
export function PortalRecovery({ moving, children }: { moving: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!moving) return;
    const dialogs = [...content.current?.querySelectorAll('dialog') ?? []];
    const previous = dialogs.map(dialog => ({ display: dialog.style.display, inert: dialog.inert }));
    dialogs.forEach(dialog => { dialog.style.display = 'none'; dialog.inert = true; });
    return () => dialogs.forEach((dialog, index) => { dialog.style.display = previous[index]!.display; dialog.inert = previous[index]!.inert; });
  }, [moving]);
  return <>{moving && <LoadingState />}<div ref={content} hidden={moving} inert={moving}>{children}</div></>;
}

/** Lives outside the household subtree so a recovered page (or the household picker) keeps the explanation. */
export function PortalRecoveryNotice() {
  const notice = usePortalRecoveryNotice();
  const cache = useQueryClient(), login = usePortalLogin();
  return notice ? <Alert role="status" className="flex flex-wrap items-center gap-3">
    <p className="min-w-0 flex-1">{t('portal/household:householdChanged')}</p>
    <Button variant="outline" onClick={() => clearPortalRecoveryNotice(cache, login)}>{t('portal/household:dismissChange')}</Button>
  </Alert> : null;
}
