// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, reloadRestoredPage } from './app.js';
import { createAppRouter } from './app/router.js';
import { createShellServices } from './app/services.js';

const reload = vi.fn();
beforeEach(() => {
  reload.mockReset();
  const { href, pathname, search, hash, origin } = window.location;
  vi.stubGlobal('location', { href, pathname, search, hash, origin, reload });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted }) as PageTransitionEvent;

it('reloads a page restored from the back-forward cache, and only that one', () => {
  reloadRestoredPage(pageshow(false));
  expect(reload).not.toHaveBeenCalled();
  reloadRestoredPage(pageshow(true));
  expect(reload).toHaveBeenCalledOnce();
});

it('listens for a restored page while the app is mounted', () => {
  // The page never answers, so no screen has to be drawn for the listener to be tested.
  const services = createShellServices(() => new Promise(() => {}));
  const app = render(<App services={services} router={createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))}/>);
  window.dispatchEvent(pageshow(false));
  expect(reload).not.toHaveBeenCalled();
  window.dispatchEvent(pageshow(true));
  expect(reload).toHaveBeenCalledOnce();
  app.unmount();
  window.dispatchEvent(pageshow(true));
  expect(reload).toHaveBeenCalledOnce();
});
