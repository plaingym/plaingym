// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ComponentProps, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { userNames } from './page.js';
import { CloseIcon } from './icons.js';
const OperationContext = createContext<Dispatch<SetStateAction<number>> | undefined>(undefined);
const DraftContext = createContext<((form?: HTMLFormElement) => void) | undefined>(undefined);
const CancelContext = createContext<(() => void) | undefined>(undefined);

let pageScrollLocks = 0;
let restorePageScroll: (() => void) | undefined;

/** Counted lock on the page's scroll: the first lock saves the root styles and the last release restores them. */
export function lockPageScroll() {
  if (pageScrollLocks++ === 0) {
    const { scrollX, scrollY } = window;
    const { style } = document.documentElement;
    // Reserve the scrollbar's gutter only when the page had a scrollbar, so a short page doesn't shift.
    const hadScrollbar = window.innerWidth - document.documentElement.clientWidth > 0;
    // A shorthand can read as empty when only one axis has an inline value.
    const overflowProperties = style.overflow ? ['overflow'] : ['overflow', 'overflow-x', 'overflow-y'];
    const properties = [...overflowProperties, 'scrollbar-gutter'].map(name => ({
      name, value: style.getPropertyValue(name), priority: style.getPropertyPriority(name),
    }));
    style.setProperty('overflow', 'hidden');
    if (hadScrollbar) style.setProperty('scrollbar-gutter', 'stable');
    restorePageScroll = () => {
      for (const { name, value, priority } of properties) style.setProperty(name, value, priority);
      window.scrollTo(scrollX, scrollY);
    };
  }
  return () => {
    if (--pageScrollLocks === 0) {
      restorePageScroll?.();
      restorePageScroll = undefined;
    }
  };
}

const actionsEndingBody = new WeakMap<Element, HTMLDivElement>();

const isHidden = (element: Element) => element.hasAttribute('hidden') || getComputedStyle(element).display === 'none';

function endsDialogBody(actions: HTMLDivElement, body: Element) {
  // A hidden bar, or a bar inside a hidden wrapper, ends nothing the user sees.
  for (let node: Element | null = actions; node && node !== body; node = node.parentElement) if (isHidden(node)) return false;
  for (let node: Element | null = actions; node && node !== body; node = node.parentElement) {
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      // A nested dialog is in the top layer, not part of this body's flow.
      if (sibling.tagName !== 'DIALOG' && !isHidden(sibling)) return false;
    }
    if (node !== actions) {
      const { paddingBottom, marginBottom } = getComputedStyle(node);
      if (parseFloat(paddingBottom) || parseFloat(marginBottom)) return false;
    }
  }
  return true;
}

/** Keep a long dialog's actions visible inside its single scrolling body, with the bar's background reaching the body edge. */
export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const actions = ref.current, body = actions?.closest('[data-dialog-body]');
    if (!actions || !body) return;
    // Move the body's bottom padding into the bar only when the bar ends the flowing content;
    // an action row followed by other content keeps the body's normal padding and its own height.
    const clearBodyEnd = () => {
      if (actionsEndingBody.get(body) === actions) {
        actionsEndingBody.delete(body);
        body.removeAttribute('data-dialog-actions-end');
      }
    };
    const update = () => {
      const atEnd = endsDialogBody(actions, body);
      actions.toggleAttribute('data-dialog-actions-at-end', atEnd);
      if (atEnd) {
        actionsEndingBody.set(body, actions);
        body.setAttribute('data-dialog-actions-end', '');
      } else clearBodyEnd();
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    // A breakpoint class can show or hide trailing content without any DOM change.
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); clearBodyEnd(); };
  }, []);
  return <div ref={ref} data-dialog-actions className={cn('sticky bottom-0 z-10 flex flex-col gap-3 border-t border-border bg-background py-3 [&[data-dialog-actions-at-end]]:pb-7 sm:flex-row sm:flex-wrap sm:[&[data-dialog-actions-at-end]]:pb-9', className)}>{children}</div>;
}
/** A Cancel or Close button that asks through the dialog's guarded dismissal, so edits are not discarded silently. */
export function DialogCancel({ onClick, ...props }: ComponentProps<typeof Button>) {
  const requestClose = useContext(CancelContext);
  return <Button {...props} onClick={event => { onClick?.(event); if (!event.defaultPrevented) requestClose?.(); }} />;
}
/** Temporarily release modal focus containment while the containing page recovers. */
export const DialogRecoveryContext = createContext<{ suspended: boolean; notice?: ReactNode; registerDialog?: () => () => void }>({ suspended: false });
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
  const { suspended, notice, registerDialog } = useContext(DialogRecoveryContext);
  useLayoutEffect(() => { if (!suspended) return registerDialog?.(); }, [suspended, registerDialog]);
  const lastFocused = useRef<HTMLElement | null>(null);
  const resume = useRef<{ focused: HTMLElement | null; positions: { element: HTMLElement; top: number; left: number }[] } | undefined>(undefined);
  const releasePageScroll = useRef<(() => void) | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
    if (dirty.current.size || unsavedChanges) { if (!confirm) dismissOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirm(true); }
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
      releasePageScroll.current?.();
      releasePageScroll.current = undefined;
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
      releasePageScroll.current?.();
      releasePageScroll.current = undefined;
      return;
    }
    if (!dialog.hasAttribute('open')) {
      releasePageScroll.current ??= lockPageScroll();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      resume.current?.focused?.focus({ preventScroll: true });
      resume.current?.positions.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
      resume.current = undefined;
    }
  }, [suspended]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || suspended) return;
    // The browser can close the dialog on its own (a second Escape, Android back). Release the page lock then.
    // The cleanup runs before this component's own close() calls on suspend and unmount, so those don't land here.
    const closed = () => {
      if (dialog.hasAttribute('open')) return;
      releasePageScroll.current?.();
      releasePageScroll.current = undefined;
      onCloseRef.current();
    };
    dialog.addEventListener('close', closed);
    return () => dialog.removeEventListener('close', closed);
  }, [suspended]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || suspended) return;
    // The reserved root gutter also narrows the top layer. Keep the modal's
    // width and alignment relative to the full viewport.
    const fitViewport = () => {
      const rect = document.documentElement.getBoundingClientRect();
      const gutter = Math.max(0, window.innerWidth - rect.width);
      // The root scrollbar sits on the left in a right-to-left page.
      const onLeft = rect.left > 0;
      dialog.style.setProperty('--dialog-scrollbar-gutter', `${gutter}px`);
      dialog.style.setProperty('--dialog-gutter-left', `${onLeft ? gutter : 0}px`);
      dialog.style.setProperty('--dialog-gutter-right', `${onLeft ? 0 : gutter}px`);
    };
    fitViewport();
    window.addEventListener('resize', fitViewport);
    return () => window.removeEventListener('resize', fitViewport);
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
    className={cn('m-0 h-dvh max-h-none w-[calc(100%+var(--dialog-scrollbar-gutter,0px))] max-w-none [left:calc(-1*var(--dialog-gutter-left,0px))] [right:calc(-1*var(--dialog-gutter-right,0px))] overflow-hidden overscroll-contain border-0 [&[open]]:flex [&[open]]:flex-col bg-background p-0 text-foreground', userNames, 'backdrop:bg-foreground/40',
      'sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[calc(100%+var(--dialog-scrollbar-gutter,0px)-2rem)] sm:rounded-xl sm:border sm:border-border sm:shadow-xl',
      size === 'wide' ? 'sm:max-w-4xl' : 'sm:max-w-2xl', className)}>
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 space-y-1 py-2">
          <h2 id={titleId} className="wrap-anywhere text-lg font-semibold">{title}</h2>
          {description && <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label={closeLabel} disabled={!dismissible || busy > 0} onClick={requestClose}><CloseIcon /></Button>
      </div>
      <div data-dialog-body className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6 [&[data-dialog-actions-end]]:pb-0">
        {notice && <div className="sticky top-0 z-10 mb-4 bg-background">{notice}</div>}
        {confirm && <div role="alert" className="mb-4 space-y-3 rounded-lg border border-border bg-muted p-4">
          <p>{t('shell/shell:discardHelp')}</p><div className="flex flex-wrap gap-2">
            <Button ref={keep} disabled={!dismissible || busy > 0} onClick={() => { setConfirm(false); dismissOrigin.current?.focus(); }}>{t('shell/shell:keepEditing')}</Button>
            <Button variant="destructive" disabled={!dismissible || busy > 0} onClick={onClose}>{t('shell/shell:discard')}</Button>
          </div>
        </div>}
        <CancelContext.Provider value={requestClose}><OperationContext.Provider value={setBusy}><DraftContext.Provider value={saved}>{children}</DraftContext.Provider></OperationContext.Provider></CancelContext.Provider>
      </div>
    </div>
  </dialog>;
}
