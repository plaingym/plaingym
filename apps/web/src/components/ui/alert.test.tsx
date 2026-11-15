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
    render(<><Alert role="status">Saved</Alert><Alert variant="error">Background read failed</Alert></>);
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole('status').dataset.variant).toBe('info');
  });
  it('switches a status into a focused failure without remounting', () => {
    const view = render(<Alert role="status">Saved</Alert>);
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
});
