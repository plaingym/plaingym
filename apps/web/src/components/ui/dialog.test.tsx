// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Dialog, DialogActions, DialogCancel, DialogRecoveryContext, useDialogOperation, useDialogSaved } from './dialog.js';
import { breaksAnywhere } from './wrap.test-helper.js';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const { style } = document.documentElement;
  style.removeProperty('overflow');
  style.removeProperty('overflow-y');
  style.removeProperty('scrollbar-gutter');
  document.documentElement.removeAttribute('dir');
  for (const key of ['clientWidth', 'getBoundingClientRect']) delete (document.documentElement as unknown as Record<string, unknown>)[key];
});

/** jsdom lays nothing out, so stub the root's widths: the page's scrollbar is `innerWidth - clientWidth`. */
function stubRoot({ innerWidth, clientWidth, left = 0, width = clientWidth }: { innerWidth: number; clientWidth: number; left?: number; width?: number }) {
  vi.stubGlobal('innerWidth', innerWidth);
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(document.documentElement, 'getBoundingClientRect', { configurable: true, value: () => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0 }) });
}

it.each([
  { clientWidth: 1000, gutter: '' },
  { clientWidth: 999, gutter: '' },
  { clientWidth: 998, gutter: 'stable' },
  { clientWidth: 985, gutter: 'stable' },
])('reserves the scrollbar gutter only when the page had a scrollbar (clientWidth $clientWidth)', ({ clientWidth, gutter }) => {
  stubRoot({ innerWidth: 1000, clientWidth });
  const { style } = document.documentElement;
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>Body</Dialog>);
  expect(style.overflow).toBe('hidden');
  expect(style.scrollbarGutter).toBe(gutter);
  view.unmount();
  expect(style.overflow).toBe('');
  expect(style.scrollbarGutter).toBe('');
});
it.each([
  { dir: 'rtl', left: 15, expected: ['15px', '0px'] },
  { dir: 'ltr', left: 0, expected: ['0px', '15px'] },
])('places the dialog by the side of the root gutter ($dir)', ({ dir, left, expected }) => {
  document.documentElement.dir = dir;
  stubRoot({ innerWidth: 1015, clientWidth: 1000, left, width: 1000 });
  render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>Body</Dialog>);
  const { style } = screen.getByRole('dialog');
  expect(style.getPropertyValue('--dialog-scrollbar-gutter')).toBe('15px');
  expect([style.getPropertyValue('--dialog-gutter-left'), style.getPropertyValue('--dialog-gutter-right')]).toEqual(expected);
});
it('releases the page lock and calls onClose once when the browser closes the dialog', () => {
  const { style } = document.documentElement;
  const onClose = vi.fn();
  render(<Dialog title="Editor" closeLabel="Close" onClose={onClose}>Body</Dialog>);
  const dialog = screen.getByRole('dialog');
  expect(style.overflow).toBe('hidden');
  dialog.removeAttribute('open');
  fireEvent(dialog, new Event('close'));
  expect(style.overflow).toBe('');
  expect(style.scrollbarGutter).toBe('');
  expect(onClose).toHaveBeenCalledOnce();
  cleanup();
  expect(style.overflow).toBe('');
  expect(onClose).toHaveBeenCalledOnce();
});
it('does not call onClose when suspending, resuming or unmounting closes the dialog itself', () => {
  const onClose = vi.fn();
  const tree = (suspended: boolean) => <DialogRecoveryContext.Provider value={{ suspended }}>
    <Dialog title="Editor" closeLabel="Close" onClose={onClose}>Body</Dialog>
  </DialogRecoveryContext.Provider>;
  const view = render(tree(false));
  const dialog = screen.getByRole('dialog', { hidden: true });
  view.rerender(tree(true));
  fireEvent(dialog, new Event('close'));
  view.rerender(tree(false));
  view.unmount();
  fireEvent(dialog, new Event('close'));
  expect(onClose).not.toHaveBeenCalled();
});
it('ignores a hidden bar and a bar inside a hidden wrapper when finding the end of the body', () => {
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>
    <p>Content</p><div hidden><DialogActions><button>Save</button></DialogActions></div>
  </Dialog>);
  expect(view.container.querySelector('[data-dialog-body]')!.hasAttribute('data-dialog-actions-end')).toBe(false);
  expect(view.container.querySelector('[data-dialog-actions]')!.hasAttribute('data-dialog-actions-at-end')).toBe(false);
});
it('does not count an open nested dialog after the bar as trailing content', () => {
  const tree = (nested: boolean) => <Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>
    <DialogActions><button>Save</button></DialogActions>{nested && <dialog open>Nested</dialog>}
  </Dialog>;
  const view = render(tree(false));
  const body = view.container.querySelector('[data-dialog-body]')!;
  expect(body.hasAttribute('data-dialog-actions-end')).toBe(true);
  view.rerender(tree(true));
  fireEvent(window, new Event('resize'));
  expect(body.hasAttribute('data-dialog-actions-end')).toBe(true);
});
it('re-checks the end of the body on a window resize', () => {
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>
    <DialogActions><button>Save</button></DialogActions><p>After</p>
  </Dialog>);
  const body = view.container.querySelector('[data-dialog-body]')!;
  expect(body.hasAttribute('data-dialog-actions-end')).toBe(false);
  const trailing = screen.getByText('After');
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
    element === trailing ? { display: 'none', paddingBottom: '0px', marginBottom: '0px' } as CSSStyleDeclaration : real(element, pseudo));
  fireEvent(window, new Event('resize'));
  expect(body.hasAttribute('data-dialog-actions-end')).toBe(true);
});
it('builds one observer for a bar however often the dialog re-renders', () => {
  const Real = MutationObserver;
  let created = 0;
  vi.stubGlobal('MutationObserver', class extends Real { constructor(callback: MutationCallback) { super(callback); created++; } });
  const tree = (title: string) => <Dialog title={title} closeLabel="Close" onClose={vi.fn()}><DialogActions><button>Save</button></DialogActions></Dialog>;
  const view = render(tree('One'));
  view.rerender(tree('Two'));
  view.rerender(tree('Three'));
  view.rerender(tree('Four'));
  expect(created).toBe(1);
});

it.each([
  { firstToClose: 'A', overflow: '', gutter: '' },
  { firstToClose: 'B', overflow: 'clip', gutter: 'stable both-edges' },
])('keeps the page locked until the last dialog closes ($firstToClose closes first)', ({ firstToClose, overflow, gutter }) => {
  const { style } = document.documentElement;
  style.setProperty('overflow', overflow, 'important');
  style.setProperty('scrollbar-gutter', gutter, 'important');
  vi.stubGlobal('scrollX', 12);
  vi.stubGlobal('scrollY', 300);
  const tree = (openA: boolean, openB: boolean) => <>
    {openA && <Dialog title="A" closeLabel="Close" onClose={vi.fn()}>First</Dialog>}
    {openB && <Dialog title="B" closeLabel="Close" onClose={vi.fn()}>Second</Dialog>}
  </>;
  const expectLocked = () => {
    expect(style.overflow).toBe('hidden');
    expect(style.scrollbarGutter).toBe('stable');
    expect(window.scrollTo).not.toHaveBeenCalled();
  };
  const view = render(tree(true, false));
  expectLocked();
  view.rerender(tree(true, true));
  expectLocked();
  view.rerender(tree(firstToClose === 'B', firstToClose === 'A'));
  expectLocked();
  view.rerender(tree(false, false));
  expect(style.overflow).toBe(overflow);
  expect(style.scrollbarGutter).toBe(gutter);
  expect(style.getPropertyPriority('overflow')).toBe(overflow ? 'important' : '');
  expect(style.getPropertyPriority('scrollbar-gutter')).toBe(gutter ? 'important' : '');
  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith(12, 300);
});

it('releases the page lock during suspension and acquires it again on resume', () => {
  const { style } = document.documentElement;
  style.overflowY = 'clip';
  vi.stubGlobal('scrollY', 300);
  const tree = (suspended: boolean) => <DialogRecoveryContext.Provider value={{ suspended }}>
    <Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>Body</Dialog>
  </DialogRecoveryContext.Provider>;
  const view = render(tree(false));
  expect(style.overflow).toBe('hidden');
  view.rerender(tree(true));
  expect(style.overflow).toBe('');
  expect(style.overflowY).toBe('clip');
  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 300);

  vi.stubGlobal('scrollY', 450);
  view.rerender(tree(false));
  expect(style.overflow).toBe('hidden');
  view.rerender(tree(true));
  view.unmount();
  expect(style.overflow).toBe('');
  expect(style.overflowY).toBe('clip');
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 450);

  const another = render(tree(false));
  expect(style.overflow).toBe('hidden');
  another.unmount();
  expect(style.overflow).toBe('');
});

it('owns suspension, preserving only dialog scroll and focus, and keeps a new dialog closed until recovery ends', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const tree = (suspended: boolean, second = false) => <DialogRecoveryContext.Provider value={{ suspended }}>
    <Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}><input aria-label="Draft" /></Dialog>
    {second && <Dialog title="Second" closeLabel="Close" onClose={vi.fn()}>Second body</Dialog>}
  </DialogRecoveryContext.Provider>;
  const view = render(tree(false));
  const dialog = screen.getByRole('dialog'), body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!, input = screen.getByLabelText('Draft');
  input.focus(); body.scrollTop = 123; fireEvent.change(input, { target: { value: 'Unfinished' } });
  view.rerender(tree(true));
  expect(dialog.hasAttribute('open')).toBe(false);
  body.scrollTop = 0;
  view.rerender(tree(true, true));
  expect(view.container.querySelectorAll('dialog[open]')).toHaveLength(0);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(tree(false, true));
  expect(view.container.querySelectorAll('dialog[open]')).toHaveLength(2);
  expect(body.scrollTop).toBe(123);
  expect((input as HTMLInputElement).value).toBe('Unfinished');
  view.rerender(tree(false));
  input.focus();
  view.rerender(tree(true));
  view.rerender(tree(false));
  expect(document.activeElement).toBe(input);
  view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
});
it('has one scroll container: the dialog clips and its column shrinks inside it', () => {
  render(<Dialog title="Session" closeLabel="Close" onClose={vi.fn()}><p>Body</p></Dialog>);
  const dialog = screen.getByRole('dialog'), column = dialog.firstElementChild!, body = screen.getByText('Body').parentElement!;
  expect(dialog.className).toContain('overflow-hidden'); expect(dialog.className).toContain('[&[open]]:flex');
  expect(column.className).toContain('min-h-0'); expect(column.className).not.toMatch(/90dvh/);
  expect(body.className).toContain('overflow-y-auto'); expect(body.className).toContain('relative');
  expect(dialog.classList.contains('overscroll-contain')).toBe(true);
  expect(body.classList.contains('overscroll-contain')).toBe(true);
});
it('moves the body bottom padding into a sticky action bar that ends the content', async () => {
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}><form><input aria-label="Name"/><DialogActions><button>Save</button></DialogActions></form></Dialog>);
  const body = screen.getByRole('dialog').querySelector<HTMLElement>('[data-dialog-body]')!;
  const actions = screen.getByRole('button', { name: 'Save' }).parentElement!;
  expect(body.className).toContain('[&[data-dialog-actions-end]]:pb-0');
  expect(body.hasAttribute('data-dialog-actions-end')).toBe(true);
  expect(actions.hasAttribute('data-dialog-actions')).toBe(true);
  expect(actions.hasAttribute('data-dialog-actions-at-end')).toBe(true);
  expect(actions.className).toContain('[&[data-dialog-actions-at-end]]:pb-7');
  expect(actions.className).toContain('sm:[&[data-dialog-actions-at-end]]:pb-9');
  // Content after the bar keeps the body's normal padding and the bar's own height.
  view.rerender(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}><form><input aria-label="Name"/><DialogActions><button>Save</button></DialogActions></form><p>After</p></Dialog>);
  const trailing = screen.getByRole('button', { name: 'Save' }).parentElement!;
  // The bar's observer reports the added sibling after the render.
  await waitFor(() => expect(body.hasAttribute('data-dialog-actions-end')).toBe(false));
  expect(trailing.hasAttribute('data-dialog-actions-at-end')).toBe(false);
  expect(trailing.className).toContain('py-3');
  view.rerender(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}><p>Body</p></Dialog>);
  const plainBody = screen.getByText('Body').parentElement!;
  expect(plainBody.hasAttribute('data-dialog-actions-end')).toBe(false);
  expect(plainBody.querySelector('[data-dialog-actions]')).toBeNull();
  expect(plainBody.className).toContain('py-4'); expect(plainBody.className).toContain('sm:py-6');
});
it('updates both padding flags when a sibling adds or removes trailing content from its own state', async () => {
  function TrailingContent() {
    const [shown, setShown] = useState(false);
    return <><p hidden style={{ display: 'block' }}>Hidden</p><p style={{ display: 'none' }}>Also hidden</p>
      {shown && <p>After</p>}
      <button hidden type="button" onClick={() => setShown(value => !value)}>Toggle trailing content</button></>;
  }
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>
    <DialogActions><button>Save</button></DialogActions><TrailingContent />
  </Dialog>);
  const body = view.container.querySelector('[data-dialog-body]')!;
  const actions = view.container.querySelector('[data-dialog-actions]')!;
  const toggle = screen.getByText('Toggle trailing content');
  const expectAtEnd = (atEnd: boolean) => {
    expect(body.hasAttribute('data-dialog-actions-end')).toBe(atEnd);
    expect(actions.hasAttribute('data-dialog-actions-at-end')).toBe(atEnd);
  };
  expectAtEnd(true);
  fireEvent.click(toggle);
  await waitFor(() => expectAtEnd(false));
  fireEvent.click(toggle);
  await waitFor(() => expectAtEnd(true));
});
it.each([{ paddingBottom: '8px' }, { marginBottom: '8px' }])('keeps body padding when a wrapper adds bottom spacing (%o)', style => {
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>
    <div style={style}><DialogActions><button>Save</button></DialogActions></div>
  </Dialog>);
  expect(view.container.querySelector('[data-dialog-body]')!.hasAttribute('data-dialog-actions-end')).toBe(false);
  expect(view.container.querySelector('[data-dialog-actions]')!.hasAttribute('data-dialog-actions-at-end')).toBe(false);
});
it('scopes the padding flags to the nested bar’s own dialog body', () => {
  const view = render(<Dialog title="Outer" closeLabel="Close" onClose={vi.fn()}>
    <Dialog title="Inner" closeLabel="Close" onClose={vi.fn()}><DialogActions><button>Save</button></DialogActions></Dialog>
  </Dialog>);
  const [outer, inner] = view.container.querySelectorAll('[data-dialog-body]');
  expect(outer!.hasAttribute('data-dialog-actions-end')).toBe(false);
  expect(inner!.hasAttribute('data-dialog-actions-end')).toBe(true);
});
it('does not report fields from a finished or discarded subview as unsaved', () => {
  const close = vi.fn();
  const view = render(<Dialog title="Session" closeLabel="Close" onClose={close}><input aria-label="Date" /></Dialog>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed date' } });
  view.rerender(<Dialog title="Session" closeLabel="Close" onClose={close}><p>Session saved</p></Dialog>);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull();
});
function Forms() {
  const saved = useDialogSaved(), first = useRef<HTMLFormElement>(null), second = useRef<HTMLFormElement>(null);
  return <><form ref={first}><input aria-label="First draft" /><button type="button" onClick={() => saved(first.current!)}>Save first</button></form>
    <form ref={second}><input aria-label="Second draft" /><button type="button" onClick={() => saved(second.current!)}>Save second</button></form></>;
}
it('clears a successful form save while preserving another form\'s unsaved fields', () => {
  const close = vi.fn(); render(<Dialog title="Session" closeLabel="Close" onClose={close}><Forms /></Dialog>);
  fireEvent.change(screen.getByLabelText('First draft'), { target: { value: 'First' } });
  fireEvent.change(screen.getByLabelText('Second draft'), { target: { value: 'Second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save first' })); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(close).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect((screen.getByLabelText('Second draft') as HTMLInputElement).value).toBe('Second');
  fireEvent.click(screen.getByRole('button', { name: 'Save second' })); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull();
});
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
it('routes a cancel button through the same unsaved-work guard and keeps edits when staying', () => {
  const close = vi.fn();
  render(<Dialog title="Edit" closeLabel="Close" onClose={close}><input aria-label="Name" /><DialogCancel>Cancel</DialogCancel></Dialog>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).not.toHaveBeenCalled(); expect(screen.getByText('Discard your unsaved changes?')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Draft');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
});
it('returns focus to the edited field after a second Cancel click and Keep editing', () => {
  render(<Dialog title="Edit" closeLabel="Close" onClose={vi.fn()}><input aria-label="Name" /><DialogCancel>Cancel</DialogCancel></Dialog>);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  input.focus(); fireEvent.change(input, { target: { value: 'Draft' } });
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.click(cancel);
  cancel.focus(); fireEvent.click(cancel);
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(document.activeElement).toBe(input);
});
it('closes at once from a cancel button when nothing changed', () => {
  const close = vi.fn();
  render(<Dialog title="Edit" closeLabel="Close" onClose={close}><DialogCancel>Cancel</DialogCancel></Dialog>);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull();
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
it('ignores sub-pixel zoom rounding in fitViewport and keeps real scrollbar gutters', () => {
  stubRoot({ innerWidth: 1000.5, clientWidth: 1000, left: 0, width: 1000 });
  const view = render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>Body</Dialog>);
  const firstStyle = screen.getByRole('dialog').style;
  expect(firstStyle.getPropertyValue('--dialog-scrollbar-gutter')).toBe('0px');
  expect(firstStyle.getPropertyValue('--dialog-gutter-left')).toBe('0px');
  expect(firstStyle.getPropertyValue('--dialog-gutter-right')).toBe('0px');
  view.unmount();

  stubRoot({ innerWidth: 1015, clientWidth: 1000, left: 0, width: 1000 });
  render(<Dialog title="Editor" closeLabel="Close" onClose={vi.fn()}>Body</Dialog>);
  const secondStyle = screen.getByRole('dialog').style;
  expect(secondStyle.getPropertyValue('--dialog-scrollbar-gutter')).toBe('15px');
  expect(secondStyle.getPropertyValue('--dialog-gutter-left')).toBe('0px');
  expect(secondStyle.getPropertyValue('--dialog-gutter-right')).toBe('15px');
});
it('keeps the title wrapping even when className sets wrap-normal', () => {
  const longTitle = 'A'.repeat(60);
  render(<Dialog title={longTitle} closeLabel="Close" className="wrap-normal" onClose={vi.fn()}>Body</Dialog>);
  const heading = screen.getByRole('heading', { level: 2, name: longTitle });
  expect(heading.classList.contains('wrap-anywhere')).toBe(false);
  expect(breaksAnywhere(heading)).toBe(true);
});
it('inherits overflow-wrap: anywhere on the title without repeating wrap-anywhere', () => {
  const longTitle = 'A'.repeat(60);
  render(<Dialog title={longTitle} closeLabel="Close" onClose={vi.fn()}>Body</Dialog>);
  const heading = screen.getByRole('heading', { level: 2, name: longTitle });
  expect(heading.classList.contains('wrap-anywhere')).toBe(false);
  expect(breaksAnywhere(heading)).toBe(true);
});
