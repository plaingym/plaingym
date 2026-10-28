// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useId, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { CloseIcon } from './icons.js';
const OperationContext = createContext<Dispatch<SetStateAction<number>> | undefined>(undefined);
const DraftContext = createContext<((form?: HTMLFormElement) => void) | undefined>(undefined);
export function useDialogSaved() {
  const saved = useContext(DraftContext);
  return (form?: HTMLFormElement) => saved?.(form);
}
/** Keep the containing dialog open while an embedded payment or save is running. */
export function useDialogOperation(busy: boolean) {
  const setBusy = useContext(OperationContext);
  useEffect(() => { if (!busy || !setBusy) return; setBusy(count => count + 1); return () => setBusy(count => count - 1); }, [busy, setBusy]);
}
/** Native focus containment, restored opener focus and guarded Escape/backdrop/close dismissal. */
export function Dialog({ title, description, closeLabel, onClose, size = 'default', className, children, dismissible = true, unsavedChanges = false }:
  { title: ReactNode; description?: ReactNode; closeLabel: string; onClose: () => void; size?: 'default' | 'wide'; className?: string; children: ReactNode; dismissible?: boolean; unsavedChanges?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId();
  const [busy, setBusy] = useState(0), [confirm, setConfirm] = useState(false);
  const dirty = useRef(new Set<HTMLElement>());
  function saved(form?: HTMLFormElement) {
    if (!form) dirty.current.clear();
    else for (const field of dirty.current) if (form.contains(field)) dirty.current.delete(field);
    if (!dirty.current.size) setConfirm(false);
  }
  const keep = useRef<HTMLButtonElement>(null), dismissOrigin = useRef<HTMLElement | null>(null), startedOutside = useRef(false);
  function requestClose() {
    if (!dismissible || busy) return;
    // Saved or discarded subviews unmount their fields. They no longer contain a draft.
    for (const field of dirty.current) if (!ref.current?.contains(field)) dirty.current.delete(field);
    if (dirty.current.size || unsavedChanges) { dismissOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirm(true); }
    else onClose();
  }
  useEffect(() => { if (confirm) keep.current?.focus(); }, [confirm]);
  function outside(x: number, y: number) {
    const bounds = ref.current!.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  }
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    return () => {
      if (dialog?.hasAttribute('open')) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} {...(description ? { 'aria-describedby': descriptionId } : {})}
    onCancel={(event) => { event.preventDefault(); if (confirm) { setConfirm(false); dismissOrigin.current?.focus(); } else requestClose(); }}
    onPointerDown={event => { startedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={event => { if (event.target === event.currentTarget && startedOutside.current && outside(event.clientX, event.clientY)) requestClose(); startedOutside.current = false; }}
    onChangeCapture={event => { if (event.target instanceof HTMLElement) dirty.current.add(event.target); }}
    className={cn('m-0 h-dvh max-h-none w-full max-w-none border-0 bg-background p-0 text-foreground backdrop:bg-foreground/40',
      'sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:rounded-xl sm:border sm:border-border sm:shadow-xl',
      size === 'wide' ? 'sm:max-w-4xl' : 'sm:max-w-2xl', className)}>
    <div className="flex h-full flex-col sm:max-h-[90dvh]">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 space-y-1 py-2">
          <h2 id={titleId} className="break-words text-lg font-semibold">{title}</h2>
          {description && <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label={closeLabel} disabled={!dismissible || busy > 0} onClick={requestClose}><CloseIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        {confirm && <div role="alert" className="mb-4 space-y-3 rounded-lg border border-border bg-muted p-4">
          <p>{t('shell/shell:discardHelp')}</p><div className="flex flex-wrap gap-2">
            <Button ref={keep} disabled={!dismissible || busy > 0} onClick={() => { setConfirm(false); dismissOrigin.current?.focus(); }}>{t('shell/shell:keepEditing')}</Button>
            <Button variant="destructive" disabled={!dismissible || busy > 0} onClick={onClose}>{t('shell/shell:discard')}</Button>
          </div>
        </div>}
        <OperationContext.Provider value={setBusy}><DraftContext.Provider value={saved}>{children}</DraftContext.Provider></OperationContext.Provider>
      </div>
    </div>
  </dialog>;
}
