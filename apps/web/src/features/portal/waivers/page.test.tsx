// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WaiverTemplate } from '@plaingym/shared/contracts';
import { SignWaiver } from './page.js';
import type { PortalScope } from '../household/api.js';
import type { PortalWaiverEndpoints } from './endpoints.js';

const template: WaiverTemplate = {
  id: '01900000-0000-7000-8000-000000000001', name: 'Participation', kind: 'waiver', version: 1,
  body: 'Terms', retiredAt: null, createdAt: '2026-11-18T12:00:00Z',
};
const member = { id: '01900000-0000-7000-8000-000000000002', firstName: 'Ava', lastName: 'Chen', dateOfBirth: '1990-01-01' };
const scope = {
  key: ['portal', 'gym', 'user', 'household', 'household'] as const,
  ready: true, moving: false, refreshing: false, settling: false,
  own: <T extends { householdId: string }>(answer: T) => answer,
  call: vi.fn(),
} as unknown as PortalScope;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the signature pad dark ink on white in either theme', () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignWaiver template={template} member={member} minor={false} endpoints={{} as PortalWaiverEndpoints} scope={scope}
      close={() => undefined} saved={async () => undefined} />
  </QueryClientProvider>);
  const canvas = document.querySelector('canvas');
  expect(canvas).not.toBeNull();
  expect(canvas!.classList.contains('bg-white')).toBe(true);
});

it('asks before discarding a started signature through the dialog Close button', async () => {
  const close = vi.fn(), user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignWaiver template={template} member={member} minor={false} endpoints={{} as PortalWaiverEndpoints} scope={scope}
      close={close} saved={async () => undefined} />
  </QueryClientProvider>);
  const dialog = screen.getByRole('dialog'), form = within(dialog), signer = form.getByLabelText('Your full name');
  await user.type(signer, 'Ava Chen');
  await user.click(form.getAllByRole('button', { name: 'Close' }).at(-1)!);
  expect(form.getByText('Discard your unsaved changes?')).toBeDefined();
  expect(close).not.toHaveBeenCalled();
  await user.click(form.getByRole('button', { name: 'Keep editing' }));
  expect((signer as HTMLInputElement).value).toBe('Ava Chen');
  expect(screen.getByRole('dialog')).toBe(dialog);
});
