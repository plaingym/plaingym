// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
import { AlertIcon } from './icons.js';

/**
 * A message announced to screen readers (`role="alert"`). `info` (the default) is a neutral note; `error` says
 * something failed, with the destructive colours `ErrorState` uses and an icon, so it never reads as a hint.
 */
export function Alert({ className, variant = 'info', children, ...props }: ComponentProps<'div'> & { variant?: 'info' | 'error' }) {
  if (variant === 'error') return <div role="alert" data-variant="error"
    className={cn('flex min-w-0 gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props}>
    <AlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
    <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">{children}</div>
  </div>;
  return <div role="alert" data-variant="info" className={cn('rounded-md border border-border bg-muted p-4 text-sm', className)} {...props}>{children}</div>;
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

/** A form's result: a failure as the `error` alert, scrolled to and focused when it appears, or a status line. */
export function FormMessage({ message, className }: { message: { kind: 'status' | 'alert'; text: string } | null; className?: string }) {
  const ref = useRevealed<HTMLDivElement>(message?.kind === 'alert' ? message : null);
  if (!message) return null;
  return message.kind === 'alert' ? <Alert ref={ref} tabIndex={-1} variant="error" className={className}>{message.text}</Alert>
    : <p role="status" className={cn('rounded-md border border-border p-3 text-sm', className)}>{message.text}</p>;
}
