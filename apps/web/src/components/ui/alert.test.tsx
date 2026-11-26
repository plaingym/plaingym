// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Alert, FormMessage } from './alert.js';

afterEach(cleanup);
describe('failure alerts', () => {
  it('focuses and scrolls a revealed form error and forwards its ref', () => {
    const ref = createRef<HTMLDivElement>(), scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<form><Alert variant="error" focusOnReveal ref={ref}>Unable to save</Alert></form>);
      expect(document.activeElement).toBe(ref.current);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(ref.current?.dataset.variant).toBe('error');
      expect(ref.current?.querySelector('svg')).toBeTruthy();
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('focuses a summary above the form on failure', () => {
    render(<><Alert variant="error" focusOnReveal>Unable to save</Alert><form/></>);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
  it('leaves focus alone for information and background read errors', () => {
    render(<><Alert focusOnReveal>Saved</Alert><Alert variant="error">Background read failed</Alert></>);
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole('status').dataset.variant).toBe('info');
  });
  it('announces a warning as a status in the warning colours without taking focus', () => {
    render(<Alert variant="warning" focusOnReveal>Careful</Alert>);
    const alert = screen.getByRole('status');
    expect(alert.dataset.variant).toBe('warning');
    expect(alert.classList.contains('border-warning/40')).toBe(true);
    expect(alert.classList.contains('bg-warning/10')).toBe(true);
    expect(alert.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
  it('switches a status into a focused failure without remounting', () => {
    const view = render(<Alert focusOnReveal>Saved</Alert>);
    view.rerender(<Alert variant="error" focusOnReveal>Unable to save</Alert>);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
  it('keeps focus on the plan select when a preview read fails inside a form', () => {
    const view = render(<form><select aria-label="Plan"><option>Monthly</option></select></form>);
    screen.getByRole('combobox').focus();
    view.rerender(<form><select aria-label="Plan"><option>Monthly</option></select><Alert variant="error">Preview failed</Alert></form>);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
  });
  it('reveals changed error text, including nested markup, without focusing on an unrelated rerender', () => {
    const content = (message: string) => <><Alert variant="error" focusOnReveal><p>{message}</p></Alert><button>Retry</button></>;
    const view = render(content('Timed out'));
    screen.getByRole('button').focus();
    view.rerender(content('Timed out'));
    expect(document.activeElement).toBe(screen.getByRole('button'));
    view.rerender(content('Unable to save'));
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
  it('keeps success neutral and focuses the next failed form message', () => {
    const view = render(<FormMessage message={{ kind: 'status', text: 'Saved' }}/>);
    expect(screen.getByRole('status').textContent).toBe('Saved');
    view.rerender(<FormMessage message={{ kind: 'alert', text: 'Unable to save' }}/>);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(screen.getByRole('alert').dataset.variant).toBe('error');
  });
  it('focuses a repeated failure with the same text, but not a rerender of the same message', () => {
    const failed = { kind: 'alert' as const, text: 'Unable to save' };
    const view = render(<><FormMessage message={failed}/><button>Save</button></>);
    screen.getByRole('button').focus();
    view.rerender(<><FormMessage message={failed}/><button>Save</button></>);
    expect(document.activeElement).toBe(screen.getByRole('button'));
    view.rerender(<><FormMessage message={{ ...failed }}/><button>Save</button></>);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
  it('neither scrolls to nor focuses an error revealed inside an inert element, until its text changes outside one', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const content = (inert: boolean, message: string) => <><button>Before</button><div inert={inert}><Alert variant="error" focusOnReveal>{message}</Alert></div></>;
      const view = render(<button>Before</button>);
      screen.getByRole('button').focus();
      view.rerender(content(true, 'Unable to sign in'));
      const button = screen.getByRole('button');
      expect(scroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
      view.rerender(content(false, 'Unable to sign in'));
      expect(scroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
      view.rerender(content(false, 'Unable to sign in again'));
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('still scrolls to an error revealed inside an inert wrapper that is hidden', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<div inert style={{ visibility: 'hidden' }}><Alert variant="error" focusOnReveal>Unable to save</Alert></div>);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('does not scroll to an error in a hidden inert wrapper inside an inert element that is still shown', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<main inert><div inert style={{ visibility: 'hidden' }}><Alert variant="error" focusOnReveal>Unable to save</Alert></div></main>);
      expect(scroll).not.toHaveBeenCalled();
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('scrolls to and focuses an error inside a wrapper that is not inert', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<div><Alert variant="error" focusOnReveal>Unable to sign in</Alert></div>);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('neither scrolls to nor focuses a form failure revealed inside an inert element that is still shown', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const view = render(<button>Before</button>);
      screen.getByRole('button').focus();
      view.rerender(<><button>Before</button><div inert><FormMessage message={{ kind: 'alert', text: 'Save failed' }} /></div></>);
      expect(scroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByRole('button'));
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('still scrolls to a form failure revealed inside an inert wrapper that is hidden', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<div inert style={{ visibility: 'hidden' }}><FormMessage message={{ kind: 'alert', text: 'Save failed' }} /></div>);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it.each([
    ['an alert', <Alert variant="error" focusOnReveal>Unable to save</Alert>],
    ['a form failure', <FormMessage message={{ kind: 'alert', text: 'Save failed' }} />],
  ])('scrolls to %s inside an open dialog under an inert element', (_, content) => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<div inert><dialog open>{content}</dialog></div>);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('reveals an error inside a closed dialog once, when the dialog opens', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const content = (open: boolean) => <><button>Before</button><dialog open={open}><Alert variant="error" focusOnReveal>Unable to save</Alert></dialog></>;
      const view = render(<button>Before</button>);
      screen.getByRole('button').focus();
      view.rerender(content(false));
      const button = screen.getByText('Before');
      expect(scroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(button);
      view.rerender(content(true));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(document.activeElement).toBe(screen.getByRole('alert'));
      view.rerender(content(true));
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
});
