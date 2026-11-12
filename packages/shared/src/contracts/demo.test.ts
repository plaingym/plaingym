// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoContracts, demoEntryResponse, demoLoginRequest, demoMenuResponse, demoSignInLinkResponse, outboxMessageResponse, outboxResponse } from './index.js';

const expiresAt = '2099-10-24T12:00:00.000Z';
describe('demo discovery', () => {
  it.each([true, false])('carries whether a sandbox can take a join (%s)', (join) => {
    expect(demoEntryResponse.parse({ data: { mode: 'sandbox', expiresAt, join } }).data).toEqual({ mode: 'sandbox', expiresAt, join });
  });
  it('requires the flag on a sandbox and rejects it on the other modes', () => {
    expect(demoEntryResponse.safeParse({ data: { mode: 'sandbox', expiresAt } }).success).toBe(false);
    expect(demoEntryResponse.safeParse({ data: { mode: 'sandbox', expiresAt, join: 'yes' } }).success).toBe(false);
    for (const mode of ['entry', 'disabled']) expect(demoEntryResponse.safeParse({ data: { mode, join: true } }).success).toBe(false);
  });
});
const id = '019a0000-0000-7000-8000-000000000001';
describe('demo sign-ins', () => {
  it('takes either a seeded role or a joined member, never both or anything else', () => {
    expect(demoLoginRequest.parse({ role: 'owner' })).toEqual({ role: 'owner' });
    expect(demoLoginRequest.parse({ member: id })).toEqual({ member: id });
    for (const body of [{ role: 'owner', member: id }, { member: 'riley' }, { role: 'admin' }, { email: 'a@example.invalid' }, {}])
      expect(demoLoginRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
  it('lists at most five joined members', () => {
    const members = Array.from({ length: 6 }, () => ({ id, name: 'Riley' }));
    expect(demoMenuResponse.safeParse({ data: { members: members.slice(1), website: false } }).success).toBe(true);
    expect(demoMenuResponse.safeParse({ data: { members, website: false } }).success).toBe(false);
  });
  it("returns only a sign-in path on the gym's own origin", () => {
    expect(demoSignInLinkResponse.safeParse({ data: { href: '/api/auth/magic-link/verify?token=t' } }).success).toBe(true);
    for (const href of ['https://evil.example/api/auth/magic-link/verify?token=t', '//evil.example/api/auth/magic-link/verify?token=t', '/admin/outbox', '/api/auth/magic-link/verify'])
      expect(demoSignInLinkResponse.safeParse({ data: { href } }).success, href).toBe(false);
  });
});

describe('demo response validation', () => {
  const id = '019a08bf-1234-7000-8000-000000000001';

  it('omits HTML from JSON responses while keeping the HTML preview', () => {
    const message = { id, subject: 'Hello', recipient: 'pat@example.test', text: 'Hello', sentAt: '2026-11-05T00:00:00Z' };
    expect(outboxResponse.parse({ data: [message], next: null }).data[0]).not.toHaveProperty('html');
    expect(outboxResponse.safeParse({ data: [{ ...message, html: '<p>Hello</p>' }], next: null }).success).toBe(false);
    expect(outboxMessageResponse.parse({ data: message }).data).not.toHaveProperty('html');
    expect(outboxMessageResponse.safeParse({ data: { ...message, html: '<p>Hello</p>' } }).success).toBe(false);
    expect(demoContracts.preview.params.safeParse({ id: 'invalid' }).success).toBe(false);
    expect(demoContracts.preview.responses[200].content['text/html'].schema.parse('<p>Hello</p>')).toBe('<p>Hello</p>');
    expect(demoContracts.preview.permission).toEqual(demoContracts.message.permission);
  });
});
