// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
/** Small inline icons. Decorative by default: pair them with visible or aria-label text. */
function Icon({ className, children, ...props }: ComponentProps<'svg'>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" className={cn('size-5 shrink-0', className)} {...props}>{children}</svg>;
}
export function MenuIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><path d="M4 6h16M4 12h16M4 18h16" /></Icon>;
}
export function CloseIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
}
export function UserIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>;
}
export function ChevronDownIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><path d="M6 9l6 6 6-6" /></Icon>;
}
export function AlertIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></Icon>;
}
export function InboxIcon(props: ComponentProps<'svg'>) {
  return <Icon {...props}><path d="M4 13l2-8h12l2 8v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></Icon>;
}
