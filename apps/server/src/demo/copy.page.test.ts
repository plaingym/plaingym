// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../locales/en/demo/demo.json' with { type: 'json' };
import { publicCopyScript } from './copy.page.js';

const prompt = new Function(publicCopyScript + '\nreturn demoCopyPrompt;')() as (response: Response) => Promise<boolean>;

beforeEach(() => {
  const dialog = HTMLDialogElement.prototype;
  if (!dialog.showModal) Object.defineProperty(dialog, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  if (!dialog.close) Object.defineProperty(dialog, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function openCopyDialog(copy: Response, pathname = '/join', bootstrap = Response.json({ data: { session: null } })) {
  const assign = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(bootstrap).mockResolvedValueOnce(copy);
  vi.stubGlobal('location', { pathname, assign });
  vi.stubGlobal('fetch', fetcher);
  const refusal = Response.json({ error: { details: { reason: ['demo_showcase_read_only'] } } }, { status: 403 });
  expect(await prompt(refusal)).toBe(true);
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
  const [button] = dialog.querySelectorAll('button');
  expect(button!.textContent).toBe('Make my own copy');
  button!.click();
  button!.click();
  function expectRequests() {
    expect(fetcher.mock.calls).toEqual([
      ['/api/auth/bootstrap', {}],
      ['/api/demo/sandboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'student', page: pathname }) }],
    ]);
  }
  return { button: button!, status: dialog.querySelector('[role="status"]')!, assign, expectRequests };
}

it.each([
  ['/join', '2400', 40],
  ['/trial', '59', 1],
  ['/drop-in', '61', 2],
] as const)('shows the hourly-limit wait on %s after Retry-After: %s', async (page, retryAfter, minutes) => {
  const dialog = await openCopyDialog(new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }), page);
  await vi.waitFor(() => expect(dialog.status.textContent).toBe(messages.copyLimitError.replace('{minutes}', String(minutes))));
  expect(dialog.button.disabled).toBe(false);
  expect(dialog.assign).not.toHaveBeenCalled();
  dialog.expectRequests();
});

it.each(['0', 'abc', '1.5', '9007199254740992', undefined])('shows capacity for Retry-After: %s', async retryAfter => {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set('Retry-After', retryAfter);
  const dialog = await openCopyDialog(new Response(null, { status: 429, headers }));
  await vi.waitFor(() => expect(dialog.status.textContent).toBe(messages.capacityError));
  expect(dialog.button.disabled).toBe(false);
  expect(dialog.assign).not.toHaveBeenCalled();
  dialog.expectRequests();
});

it('keeps the generic failure text for a server error, even after a limited bootstrap', async () => {
  const bootstrap = new Response(null, { status: 429, headers: { 'Retry-After': '2400' } });
  const dialog = await openCopyDialog(new Response(null, { status: 500 }), '/join', bootstrap);
  await vi.waitFor(() => expect(dialog.status.textContent).toBe('We could not create your copy. Please try again.'));
  expect(dialog.button.disabled).toBe(false);
  expect(dialog.assign).not.toHaveBeenCalled();
  dialog.expectRequests();
});

it('navigates to the new copy with its handoff token', async () => {
  const dialog = await openCopyDialog(Response.json({ data: { origin: 'https://copy.example.test', handoffToken: 't' } }, { status: 201 }));
  await vi.waitFor(() => expect(dialog.assign).toHaveBeenCalledExactlyOnceWith('https://copy.example.test/demo#copyToken=t'));
  expect(dialog.status.textContent).toBe('');
  dialog.expectRequests();
});
