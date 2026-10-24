// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
/** The one page container: full width on phones, centered and capped on wide screens. The shell supplies the gutters. */
export function Page({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto w-full max-w-6xl space-y-6', className)} {...props} />;
}
/** Page title, optional description, and actions. Actions sit below the title on phones and to its right from `sm`. */
export function PageHeader({ title, description, actions, className }:
  { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
    <div className="min-w-0 space-y-1">
      <h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2 sm:shrink-0">{actions}</div>}
  </div>;
}
/** A titled section inside a page. */
export function PageSection({ title, description, actions, className, children }:
  { title?: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={cn('space-y-3', className)}>
    {(title || actions) && <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        {title && <h2 className="break-words text-lg font-semibold">{title}</h2>}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:shrink-0">{actions}</div>}
    </div>}
    {children}
  </section>;
}
