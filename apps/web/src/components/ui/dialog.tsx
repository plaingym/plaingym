// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { CloseIcon } from './icons.js';
const OperationContext = createContext<Dispatch<SetStateAction<number>> | undefined>(undefined);
const DraftContext = createContext<((form?: HTMLFormElement) => void) | undefined>(undefined);
/** Temporarily release modal focus containment while the containing page recovers. */
export const DialogRecoveryContext = createContext<{ suspended: boolean; notice?: ReactNode }>({ suspended: false });
export function useDialogSaved() {
  const saved = useContext(DraftContext);
  return (form?: HTMLFormElement) => saved?.(form);
}
/** Keep the containing dialog open while an embedded payment or save is running. */
export function useDialogOperation(busy: boolean) {
  const setBusy = useContext(OperationContext);
  useEffect(() => { if (!busy || !setBusy) return; setBusy(count => count + 1); return () => setBusy(count => count - 1); }, [busy, setBusy]);
}
/** Tab skips an unchecked radio whose named group has a checked one, so it can't be a wrap boundary. */
const skippedRadio = (element: HTMLElement) => element instanceof HTMLInputElement && element.type === 'radio' && !element.checked && !!element.name
  && [...(element.form ?? element.ownerDocument).querySelectorAll<HTMLInputElement>('input[type="radio"]')].some(other => other.name === element.name && other.checked);
/** Native focus containment, restored opener focus and guarded Escape/backdrop/close dismissal. */
export function Dialog({ title, description, closeLabel, onClose, size = 'default', className, children, dismissible = true, unsavedChanges = false }:
  { title: ReactNode; description?: ReactNode; closeLabel: string; onClose: () => void; size?: 'default' | 'wide'; className?: string; children: ReactNode; dismissible?: boolean; unsavedChanges?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId();
  const { suspended, notice } = useContext(DialogRecoveryContext);
  const lastFocused = useRef<HTMLElement | null>(null);
  const resume = useRef<{ focused: HTMLElement | null; positions: { element: HTMLElement; top: number; left: number }[] } | undefined>(undefined);
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
  useLayoutEffect(() => {
    const dialog = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (dialog?.hasAttribute('open')) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (suspended) {
      if (dialog.hasAttribute('open')) {
        resume.current = { focused: document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement : lastFocused.current,
          positions: [dialog, ...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollTop || element.scrollLeft)
            .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })) };
        if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      }
      return;
    }
    if (!dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      resume.current?.focused?.focus({ preventScroll: true });
      resume.current?.positions.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
      resume.current = undefined;
    }
  }, [suspended]);
  return <dialog ref={ref} aria-labelledby={titleId} {...(description ? { 'aria-describedby': descriptionId } : {})}
    onKeyDown={event => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const dialog = event.currentTarget;
      const controls = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable="true"]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && !skippedRadio(element)
          && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
      // A native modal makes the page inert, but Chromium can still tab from its
      // last control into browser chrome. Wrap explicitly in both directions.
      const first = controls[0], last = controls.at(-1), focused = document.activeElement;
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (focused === first || focused === dialog)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (focused === last || focused === dialog)) { event.preventDefault(); first.focus(); }
    }}
    onFocusCapture={event => { lastFocused.current = event.target; }}
    onCancel={(event) => { event.preventDefault(); if (confirm) { setConfirm(false); dismissOrigin.current?.focus(); } else requestClose(); }}
    onPointerDown={event => { startedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={event => { if (event.target === event.currentTarget && startedOutside.current && outside(event.clientX, event.clientY)) requestClose(); startedOutside.current = false; }}
    onChangeCapture={event => { if (event.target instanceof HTMLElement) dirty.current.add(event.target); }}
    className={cn('m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 [&[open]]:flex [&[open]]:flex-col bg-background p-0 text-foreground backdrop:bg-foreground/40',
      'sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:rounded-xl sm:border sm:border-border sm:shadow-xl',
      size === 'wide' ? 'sm:max-w-4xl' : 'sm:max-w-2xl', className)}>
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 space-y-1 py-2">
          <h2 id={titleId} className="break-words text-lg font-semibold">{title}</h2>
          {description && <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label={closeLabel} disabled={!dismissible || busy > 0} onClick={requestClose}><CloseIcon /></Button>
      </div>
      <div data-dialog-body className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        {notice && <div className="sticky top-0 z-10 mb-4 bg-background">{notice}</div>}
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
