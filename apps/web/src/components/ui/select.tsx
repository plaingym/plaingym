// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
/** A native select at the same 44 px height as Input; native pickers work best on phones. */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('flex h-11 w-full rounded-md border border-input bg-background px-3 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', className)} {...props} />;
}
/** Multi-line text input sized like Input. */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', className)} {...props} />;
}
/** A checkbox inside its label, so the whole row is a 44 px touch target. */
export function CheckboxField({ label, className, ...props }: Omit<ComponentProps<'input'>, 'type'> & { label: ReactNode }) {
  return <label className={cn('flex min-h-11 cursor-pointer items-center gap-3 text-sm', className)}>
    <input type="checkbox" className="size-5 shrink-0 accent-primary" {...props} />
    <span>{label}</span>
  </label>;
}
