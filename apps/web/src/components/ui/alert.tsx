// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useImperativeHandle, type ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
import { AlertIcon } from './icons.js';

/**
 * A message announced to screen readers (`status` for info and warning, `alert` for error). `info` (the default) is a neutral
 * note; `warning` is a caution, in the warning colours; `error` says something failed, with the destructive colours
 * `ErrorState` uses and an icon, so it never reads as a hint.
 * `focusOnReveal` opts submit errors into scrolling and focus on reveal and whenever the rendered message changes.
 */
export function Alert({ className, variant = 'info', focusOnReveal = false, children, ref: forwardedRef, ...props }: ComponentProps<'div'> & { variant?: 'info' | 'warning' | 'error'; focusOnReveal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const revealed = useRef<{ enabled: boolean; text: string | null } | null>(null);
  useImperativeHandle(forwardedRef, () => ref.current!);
  // Compare the rendered message, including nested markup, without revealing again just because JSX was recreated.
  useEffect(() => {
    const element = ref.current;
    const enabled = variant === 'error' && focusOnReveal, text = element?.textContent ?? null;
    const previous = revealed.current;
    revealed.current = { enabled, text };
    if (!enabled || !element || (previous?.enabled && previous.text === text)) return;
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
 */
export function useRevealed<T extends HTMLElement>(shown: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!shown || !element) return;
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
