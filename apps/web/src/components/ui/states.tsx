// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { t } from '../../lib/i18n.js';
import { Button } from './button.js';
import { AlertIcon, InboxIcon } from './icons.js';
/** Shown while a page or section loads. Announced politely to screen readers. */
export function LoadingState({ label = t('shell/shell:loading'), className }: { label?: ReactNode; className?: string }) {
  return <div role="status" className={cn('flex items-center gap-3 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground', className)}>
    <span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
    <span>{label}</span>
  </div>;
}
/** Shown when a list or page has nothing yet; offer the next step as `action`. */
export function EmptyState({ title, description, action, className }:
  { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-10 text-center', className)}>
    <InboxIcon className="size-8 text-muted-foreground" />
    <div className="space-y-1">
      <p className="font-semibold">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {action}
  </div>;
}
/** Shown when loading fails. Never put server error details in `message`. */
export function ErrorState({ title = t('shell/shell:error'), message, onRetry, retryLabel = t('shell/shell:retry'), className }:
  { title?: ReactNode; message?: ReactNode; onRetry?: () => void; retryLabel?: ReactNode; className?: string }) {
  return <div role="alert" className={cn('flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center', className)}>
    <AlertIcon className="text-destructive" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="font-semibold">{title}</p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
    {onRetry && <Button variant="outline" onClick={onRetry}>{retryLabel}</Button>}
  </div>;
}
