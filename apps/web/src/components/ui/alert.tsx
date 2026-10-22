// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';
export function Alert({ className, ...props }: ComponentProps<'div'>) {
  return <div role="alert" className={cn('rounded-md border border-border bg-muted p-4 text-sm', className)} {...props} />;
}
