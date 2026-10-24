// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
/** Lets a wide table scroll inside its own box instead of the page. The region is focusable so keyboard users can scroll it. */
export function TableContainer({ label, className, ...props }: ComponentProps<'div'> & { label: string }) {
  return <div role="region" aria-label={label} tabIndex={0}
    className={cn('overflow-x-auto rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props} />;
}
/** Stacked rows for phones: each item is a card; switch to a table from `md` where columns fit. */
export function StackedList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul className={cn('divide-y divide-border rounded-xl border border-border', className)} {...props} />;
}
export function StackedItem({ className, ...props }: ComponentProps<'li'>) {
  return <li className={cn('flex flex-col gap-1 p-4', className)} {...props} />;
}
/** Status and tag labels. */
export function Badge({ tone = 'default', className, ...props }: ComponentProps<'span'> & { tone?: 'default' | 'success' | 'warning' | 'destructive' | 'muted' }) {
  const tones = {
    default: 'bg-secondary text-secondary-foreground', success: 'bg-success/10 text-success', warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive', muted: 'bg-muted text-muted-foreground',
  };
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone], className)} {...props} />;
}
