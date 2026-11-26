// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useRef, useImperativeHandle, type ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
import { DialogRecoveryContext } from './dialog.js';
import { AlertIcon } from './icons.js';

/**
 * An element under an open phone menu (inert and still shown) can't take the focus, and a scroll would move the locked
 * page behind the menu. An inert page that is also hidden isn't held by a menu, since it is only waiting to come back
 * (portal recovery, see `waitsForPage`), unless an inert element further out is still shown (the menu is open over the
 * recovering page). An open modal dialog stays usable under an inert page.
 */
function heldByMenu(element: HTMLElement) {
  if (element.closest('dialog')?.hasAttribute('open')) return false;
  for (let inert = element.closest('[inert]'); inert; inert = inert.parentElement?.closest('[inert]') ?? null)
    if (getComputedStyle(inert).visibility !== 'hidden') return true;
  return false;
}

/** A page hidden while the portal reads the household again can't take the focus yet. */
function waitsForPage(element: HTMLElement) {
  return !element.closest('dialog')?.hasAttribute('open') && element.closest('[inert]') !== null && !heldByMenu(element);
}

/**
 * A message announced to screen readers (`status` for info and warning, `alert` for error). `info` (the default) is a neutral
 * note; `warning` is a caution, in the warning colours; `error` says something failed, with the destructive colours
 * `ErrorState` uses and an icon, so it never reads as a hint.
 * `focusOnReveal` opts submit errors into scrolling and focus on reveal and whenever the rendered message changes;
 * one revealed inside an inert element that is still shown, as under an open phone menu, and not inside an open dialog, is
 * neither scrolled to nor focused; one inside a dialog that is closed for now is revealed when the dialog opens, and one
 * inside a page that is hidden for now (inert and not shown, outside an open dialog) is revealed when the page is shown.
 */
export function Alert({ className, variant = 'info', focusOnReveal = false, children, ref: forwardedRef, ...props }: ComponentProps<'div'> & { variant?: 'info' | 'warning' | 'error'; focusOnReveal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const revealed = useRef<{ enabled: boolean; text: string | null } | null>(null);
  useImperativeHandle(forwardedRef, () => ref.current!);
  // Portal recovery hides the page and closes dialogs, and shows them again through this context, so the alert renders
  // again when its page is shown or its dialog opens, and an error that waited is revealed then.
  useContext(DialogRecoveryContext);
  // Compare the rendered message, including nested markup, without revealing again just because JSX was recreated.
  useEffect(() => {
    const element = ref.current;
    const enabled = variant === 'error' && focusOnReveal, text = element?.textContent ?? null;
    const previous = revealed.current;
    // An error inside a dialog that is closed for now waits, unrevealed, until it opens again.
    const dialog = element?.closest('dialog');
    if (enabled && dialog && !dialog.hasAttribute('open')) return;
    // So does one inside a page that is hidden for now, until the page is shown.
    if (enabled && element && waitsForPage(element)) return;
    revealed.current = { enabled, text };
    if (!enabled || !element || (previous?.enabled && previous.text === text)) return;
    if (heldByMenu(element)) return;
    element.scrollIntoView?.({ block: 'center' });
    element.focus({ preventScroll: true });
  });
  if (variant === 'error') return <div ref={ref} tabIndex={-1} role="alert" data-variant="error"
    className={cn('flex min-w-0 gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props}>
    <AlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
    <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">{children}</div>
  </div>;
  if (variant === 'warning') return <div ref={ref} role="status" data-variant="warning" className={cn('rounded-md border border-warning/40 bg-warning/10 p-4 text-sm', className)} {...props}>{children}</div>;
  return <div ref={ref} role="status" data-variant="info" className={cn('rounded-md border border-border bg-muted p-4 text-sm', className)} {...props}>{children}</div>;
}

/**
 * For an error shown at the top of a long form: when `shown` becomes truthy (or changes), scrolls the element into view
 * and moves focus to it, so an owner scrolled down at the submit button sees what happened. Give it `tabIndex={-1}`.
 * Like `Alert`, it neither scrolls to nor focuses an element under an open phone menu.
 */
export function useRevealed<T extends HTMLElement>(shown: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!shown || !element) return;
    if (heldByMenu(element)) return;
    element.scrollIntoView?.({ block: 'center' });
    element.focus({ preventScroll: true });
  }, [shown]);
  return ref;
}

/**
 * A form's result: a failure as the `error` alert, scrolled to and focused when it appears, or a status line. Each new
 * `message` object reveals again, so a repeated failure with the same text still takes focus: keep the object stable
 * between renders (state, or `useMemo`) rather than building it inline.
 */
export function FormMessage({ message, className }: { message: { kind: 'status' | 'alert'; text: string } | null; className?: string }) {
  const ref = useRevealed<HTMLDivElement>(message?.kind === 'alert' ? message : null);
  if (!message) return null;
  return message.kind === 'alert' ? <Alert ref={ref} tabIndex={-1} variant="error" className={className}>{message.text}</Alert>
    : <p role="status" className={cn('rounded-md border border-border p-3 text-sm', className)}>{message.text}</p>;
}
