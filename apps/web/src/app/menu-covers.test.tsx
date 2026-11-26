// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useMenuCovers } from './menu-covers.js';

function Menu({ open }: { open: boolean }) {
  useMenuCovers(open);
  return null;
}

/** An element appended to the page, outside the rendered menu. */
function append<K extends keyof HTMLElementTagNameMap>(tag: K, marked: boolean, parent: HTMLElement = document.body) {
  const element = document.createElement(tag);
  element.inert = false;
  if (marked) element.setAttribute('data-menu-covers', '');
  parent.append(element);
  return element;
}

/** Lets the mutation observer see what was just appended. */
const observed = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('useMenuCovers', () => {
  it('makes a marked element added while the menu is open inert until it closes', async () => {
    const view = render(<Menu open />);
    const block = append('div', true);
    append('button', false, block);
    await waitFor(() => expect(block.inert).toBe(true));
    view.rerender(<Menu open={false} />);
    expect(block.inert).toBe(false);
  });

  it('covers a marked element inside an added wrapper, not the wrapper', async () => {
    const view = render(<Menu open />);
    const wrapper = document.createElement('div');
    wrapper.inert = false;
    const message = append('p', true, wrapper);
    document.body.append(wrapper);
    await waitFor(() => expect(message.inert).toBe(true));
    expect(wrapper.inert).toBe(false);
    view.rerender(<Menu open={false} />);
    expect(message.inert).toBe(false);
  });

  it('leaves an element that was added inert as it was', async () => {
    const view = render(<Menu open />);
    const block = document.createElement('div');
    block.setAttribute('data-menu-covers', '');
    block.inert = true;
    document.body.append(block);
    await observed();
    expect(block.inert).toBe(true);
    view.rerender(<Menu open={false} />);
    expect(block.inert).toBe(true);
  });

  it('gives an element moved while the menu is open what it had before the menu covered it', async () => {
    const view = render(<Menu open={false} />);
    const block = append('div', true);
    view.rerender(<Menu open />);
    document.body.prepend(block);
    await observed();
    expect(block.inert).toBe(true);
    view.rerender(<Menu open={false} />);
    expect(block.inert).toBe(false);
  });

  it('covers a marked element present before the menu opens and restores it', () => {
    const view = render(<Menu open={false} />);
    const block = append('div', true);
    expect(block.inert).toBe(false);
    view.rerender(<Menu open />);
    expect(block.inert).toBe(true);
    view.rerender(<Menu open={false} />);
    expect(block.inert).toBe(false);
  });

  it('returns a focus that lands in a marked element to where it was', () => {
    const outside = append('button', false);
    outside.focus();
    render(<Menu open />);
    const inner = append('button', false, append('div', true));
    inner.focus();
    expect(document.activeElement).toBe(outside);
  });

  it('leaves the focus in a marked element when nothing had it before', () => {
    render(<Menu open />);
    expect(document.activeElement).toBe(document.body);
    const inner = append('button', false, append('div', true));
    inner.focus();
    expect(document.activeElement).toBe(inner);
  });

  it('returns the focus only once when it moves between marked elements', () => {
    render(<Menu open />);
    const first = append('button', false, append('div', true));
    const second = append('button', false, append('div', true));
    first.focus();
    second.focus();
    expect(document.activeElement).toBe(first);
  });

  it('leaves the focus where it lands once the menu closes', () => {
    const outside = append('button', false);
    const view = render(<Menu open />);
    view.rerender(<Menu open={false} />);
    outside.focus();
    const inner = append('button', false, append('div', true));
    inner.focus();
    expect(document.activeElement).toBe(inner);
  });

  it('covers nothing added after it unmounts', async () => {
    const view = render(<Menu open />);
    view.unmount();
    const block = append('div', true);
    await observed();
    expect(block.inert).toBe(false);
  });
});
