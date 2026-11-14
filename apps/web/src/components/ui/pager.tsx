// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n.js';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';

/** One-page lists have no pager; a stale offset still offers a way back. A `label` makes it a named navigation landmark, so
 * give one only where a screen shows a single pager: two landmarks with the same name can't be told apart. */
export function Pager({ offset, total, limit = 20, onChange, disabled = false, label,
  previousLabel = t('shell/shell:previous'), nextLabel = t('shell/shell:next'), children, className }: {
  offset: number; total: number; limit?: number; onChange: (offset: number) => void; disabled?: boolean;
  label?: string; previousLabel?: string; nextLabel?: string; children?: ReactNode; className?: string;
}) {
  if (offset === 0 && total <= limit) return null;
  const Wrapper = label ? 'nav' : 'div';
  return <Wrapper aria-label={label} className={cn('flex flex-wrap items-center gap-3', className)}>
    <Button variant="outline" disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{previousLabel}</Button>
    {children}
    <Button variant="outline" disabled={disabled || offset + limit >= total} onClick={() => onChange(offset + limit)}>{nextLabel}</Button>
  </Wrapper>;
}
