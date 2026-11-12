// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { DialogRecoveryContext } from '../../../components/ui/dialog.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { t } from '../../../lib/i18n.js';
import { clearPortalRecoveryNotice, usePortalHouseholdKey, usePortalLogin, usePortalRecoveryNotice } from './api.js';

/** A failed refetch of a read pages keep showing from cache and have no failure state for. Every other read shows its own. */
function refetchFailed(query: Query) {
  const [area, part] = query.queryKey.slice(5);
  return (area === 'context' || area === 'act-for' || (area === 'household' && part === 'details'))
    && query.isActive() && query.state.data !== undefined && query.state.status === 'error';
}

/** Lives inside Page, retaining layout and drafts while dialogs release their own top-layer block. */
export function PortalRecovery({ moving, children }: { moving: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const cache = useQueryClient(), key = usePortalHouseholdKey();
  const failed = useSyncExternalStore(useCallback(notify => cache.getQueryCache().subscribe(event => {
    if (key.every((part, index) => event.query.queryKey[index] === part)) notify();
  }), [cache, key]), () => cache.getQueryCache().findAll({ queryKey: key }).some(refetchFailed));
  useLayoutEffect(() => {
    if (moving) {
      // A submitting button may already have lost focus. Dialogs preserve their own focus and scroll.
      const focused = document.activeElement instanceof HTMLElement && content.current?.contains(document.activeElement)
        ? document.activeElement : document.activeElement === document.body ? lastFocused.current : null;
      restore.current = focused?.closest('dialog') ? null : focused;
    } else {
      if (restore.current?.isConnected) restore.current.focus({ preventScroll: true });
      restore.current = null;
    }
  }, [moving]);
  const notice = !moving && failed ? <ErrorState onRetry={() => void cache.invalidateQueries({ queryKey: key, predicate: refetchFailed })} /> : undefined;
  return <DialogRecoveryContext.Provider value={{ suspended: moving, notice }}><div>
    {moving && <div className="sticky top-4 z-10 h-0"><LoadingState /></div>}
    <div ref={content} className="space-y-6" style={moving ? { visibility: 'hidden' } : undefined} inert={moving}
      onFocusCapture={event => { lastFocused.current = event.target; }}>
      {notice && <div className="sticky top-4 z-10 bg-background">{notice}</div>}{children}
    </div>
  </div></DialogRecoveryContext.Provider>;
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
