// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { CloseIcon } from './icons.js';
/** A modal dialog, open while mounted: full screen on phones, a centered panel from `sm`. The native
 * dialog element keeps focus inside and makes the page behind it inert; Escape or the close button
 * calls `onClose`, and focus returns to where it was when the dialog opened. */
export function Dialog({ title, description, closeLabel, onClose, size = 'default', className, children }:
  { title: ReactNode; description?: ReactNode; closeLabel: string; onClose: () => void; size?: 'default' | 'wide'; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    return () => {
      if (dialog?.hasAttribute('open')) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} {...(description ? { 'aria-describedby': descriptionId } : {})}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    className={cn('m-0 h-dvh max-h-none w-full max-w-none border-0 bg-background p-0 text-foreground backdrop:bg-foreground/40',
      'sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:rounded-xl sm:border sm:border-border sm:shadow-xl',
      size === 'wide' ? 'sm:max-w-4xl' : 'sm:max-w-2xl', className)}>
    <div className="flex h-full flex-col sm:max-h-[90dvh]">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 space-y-1 py-2">
          <h2 id={titleId} className="break-words text-lg font-semibold">{title}</h2>
          {description && <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}><CloseIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">{children}</div>
    </div>
  </dialog>;
}
