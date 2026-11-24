// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';
/** Every size keeps a 44 px touch target (min-h-11). */
export const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md wrap-normal text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  { variants: {
    variant: {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      outline: 'border border-input bg-background hover:bg-muted',
      ghost: 'hover:bg-muted',
      destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      link: 'text-primary underline underline-offset-4 hover:no-underline',
    },
    size: {
      default: 'px-4 py-2',
      sm: 'px-3 py-1',
      icon: 'min-w-11 p-2',
    },
  }, defaultVariants: { variant: 'default', size: 'default' } },
);
export const nameWrapClass = 'min-w-0 max-w-full wrap-anywhere';
export const nameWrapMarker = { 'data-name-wrap': '' } as const;

export function Button({ className, variant, size, asChild = false, wrap = false, type, ...props }:
  ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** For buttons whose text carries a user-supplied name: wraps long names (min-w-0 max-w-full wrap-anywhere) and adds the data-name-wrap marker that layout probes find. */
    wrap?: boolean;
  }) {
  const Component = asChild ? Slot : 'button';
  return <Component {...(!asChild ? { type: type ?? 'button' } : {})} {...(wrap ? nameWrapMarker : {})}
    className={cn(buttonVariants({ variant, size }), wrap && nameWrapClass, className)} {...props} />;
}
