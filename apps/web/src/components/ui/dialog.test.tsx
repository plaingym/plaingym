// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog, useDialogOperation } from './dialog.js';

afterEach(cleanup);
function backdrop() {
  const dialog = screen.getByRole('dialog');
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 500, top: 100, bottom: 500 } as DOMRect);
  // jsdom lacks PointerEvent's coordinates.
  fireEvent(dialog, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
}
it('dismisses only a complete outside click and returns focus after unmount', () => {
  const close = vi.fn(), opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const view = render(<Dialog title="Details" closeLabel="Close" onClose={close}><button>Inside</button></Dialog>);
  fireEvent.click(screen.getByRole('button', { name: 'Inside' })); expect(close).not.toHaveBeenCalled();
  backdrop(); expect(close).toHaveBeenCalledTimes(1);
  view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
});
it('does not dismiss when a drag begins inside and finishes outside', () => {
  const close = vi.fn(); render(<Dialog title="Details" closeLabel="Close" onClose={close}><button>Inside</button></Dialog>);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
  fireEvent.click(screen.getByRole('dialog'), { clientX: -1, clientY: -1 }); expect(close).not.toHaveBeenCalled();
});
it('supports Escape and protects unsaved work with an inline confirmation', () => {
  const close = vi.fn(); render(<Dialog title="Edit" closeLabel="Close" onClose={close}><input aria-label="Name" /></Dialog>);
  const input = screen.getByRole('textbox'); input.focus(); fireEvent.change(input, { target: { value: 'Draft' } });
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled(); expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })); expect(document.activeElement).toBe(input);
  backdrop(); fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); expect(close).toHaveBeenCalledOnce();
});
it('blocks Escape, backdrop and close during operations, then permits dismissal', () => {
  const close = vi.fn();
  function Operation({ busy }: { busy: boolean }) { useDialogOperation(busy); return <p>Saving</p>; }
  const view = render(<Dialog title="Edit" closeLabel="Close" onClose={close}><Operation busy /></Dialog>);
  backdrop(); fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Dialog title="Edit" closeLabel="Close" onClose={close}><Operation busy={false} /></Dialog>);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true })); expect(close).toHaveBeenCalledOnce();
});
