// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { t } from '../../../lib/i18n.js';
import { clearPortalRecoveryNotice, usePortalHouseholdKey, usePortalLogin, usePortalRecoveryNotice } from './api.js';

/** A failed refetch of a read pages keep showing from cache and have no failure state for. Every other read shows its own. */
function refetchFailed(query: Query) {
  const [area, part] = query.queryKey.slice(5);
  return (area === 'context' || area === 'act-for' || (area === 'household' && part === 'details'))
    && query.isActive() && query.state.data !== undefined && query.state.status === 'error';
}

/** Preserve layout and drafts while releasing a modal's top-layer block during recovery. */
export function PortalRecovery({ moving, children }: { moving: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  // A submitting button can become disabled (and lose browser focus) before its answer starts recovery.
  const lastFocused = useRef<HTMLElement | null>(null);
  const restore = useRef<(() => void) | undefined>(undefined);
  const cache = useQueryClient(), key = usePortalHouseholdKey();
  const failed = useSyncExternalStore(useCallback(notify => cache.getQueryCache().subscribe(notify), [cache]),
    () => cache.getQueryCache().findAll({ queryKey: key }).some(refetchFailed));
  useLayoutEffect(() => {
    // Restore only when this page survives recovery, never while unmounting after a move or navigation.
    if (!moving) { restore.current?.(); restore.current = undefined; return; }
    const root = content.current;
    if (!root || restore.current) return;
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement
      : document.activeElement === document.body ? lastFocused.current : null;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const positions = [...root.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    const dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog[open]')];
    dialogs.forEach(dialog => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); });
    root.style.visibility = 'hidden'; root.inert = true;
    restore.current = () => {
      root.style.visibility = ''; root.inert = false;
      if (!root.isConnected) return;
      dialogs.forEach(dialog => { if (dialog.isConnected) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); } });
      focused?.focus({ preventScroll: true });
      positions.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
      window.scrollTo(scroll.x, scroll.y);
    };
  }, [moving]);
  // The hidden page keeps its height and the window its scroll, so the loading state sticks to the viewport without moving the page.
  return <>{moving && <div className="sticky top-4 h-0"><LoadingState /></div>}
    <div ref={content} onFocusCapture={event => { lastFocused.current = event.target; }}>{!moving && failed && <ErrorState className="mb-6" onRetry={() => void cache.invalidateQueries({ queryKey: key, predicate: refetchFailed })} />}{children}</div></>;
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
