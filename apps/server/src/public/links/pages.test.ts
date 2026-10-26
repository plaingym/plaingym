// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { linkPage } from './page.js';
import { checkoutReceipts } from './receipt.js';
import { cachedLinkAsset } from './assets.js';
import messages from '../../../../../locales/en/public/links.json' with { type: 'json' };
const t = createTranslator({ 'public/links': messages });
const now = new Date('2026-10-25T12:00:00Z');
describe('signed-link presentation and return receipts', () => {
  it('escapes member names and template content and renders guardian consent', () => {
    const page = linkPage({ now, timezone: 'UTC', t, tablet: true, data: { purpose: 'sign_waiver',
      member: { id: 'member', firstName: '<script>alert(1)</script>', lastName: 'Child', dateOfBirth: '2020-01-01', revision: 1 },
      templates: [{ id: 'template', name: 'Terms', kind: 'waiver', version: 1, body: '<img src=x onerror=alert(1)>', retiredAt: null, createdAt: now.toISOString() }], signatures: [] } });
    expect(page).toContain('&lt;script&gt;'); expect(page).not.toContain('<img src=x');
    expect(page).toContain('parent or guardian must sign'); expect(page).not.toContain('value="self"');
    expect(page).toContain('viewport'); expect(page).toContain('/source'); expect(page).toContain('min-h-11');
    expect(page).toContain('Finish and clear screen'); expect(page).not.toContain('public/links:');
  });
  it('used credentials show a friendly message without any resource details or scripts', () => {
    const page = linkPage({ now, timezone: 'UTC', t, state: 'alreadyDone' });
    expect(page).toContain('Already done'); expect(page).not.toContain('data-waiver'); expect(page).not.toContain('/l/client.js');
  });
  it('authenticates the link, gym, session and expiry in the return receipt', () => {
    const receipts = checkoutReceipts(new Uint8Array(32).fill(19));
    const input = { token: 'a'.repeat(43), gymId: '00000000-0000-7000-8000-000000000001', linkId: '00000000-0000-7000-8000-000000000002', sessionId: 'cs_1', expires: now.getTime() + 1000, tablet: true };
    const sealed = receipts.seal(input);
    expect(receipts.open(sealed, now, input)).toEqual(input);
    expect(receipts.open(sealed, new Date(input.expires), input)).toBeNull();
    const [payload, signature] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...input, sessionId: 'cs_other' })).toString('base64url');
    expect(receipts.open(forged + '.' + signature, now, input)).toBeNull();
    expect(receipts.open(payload + '.invalid', now, input)).toBeNull();
    expect(receipts.open(sealed + '.extra', now, input)).toBeNull();
    expect(checkoutReceipts(new Uint8Array(32).fill(18)).open(sealed, now, input)).toBeNull();
    expect(receipts.open(sealed, now, { ...input, gymId: input.linkId })).toBeNull();
    expect(receipts.open(sealed, now, { ...input, linkId: input.gymId })).toBeNull();
    const parts = sealed.split('.');
    const ciphertext = Buffer.from(parts[2]!, 'base64url'); ciphertext[0] = ciphertext[0]! ^ 1;
    parts[2] = ciphertext.toString('base64url');
    expect(receipts.open(parts.join('.'), now, input)).toBeNull();
    expect(sealed).not.toContain(input.token);
    for (const part of sealed.split('.')) expect(Buffer.from(part, 'base64url').toString()).not.toContain(input.token);
    expect(receipts.seal(input)).not.toBe(sealed);
  });
  it('formats the document language, money and calendar date using the display locale', () => {
    const page = linkPage({ now, timezone: 'America/Vancouver', locale: 'fr-CA', t, data: { purpose: 'pay_invoice',
      invoice: { invoice: { id: 'invoice', number: 1, kind: 'one_off', status: 'open', dueOn: '2026-10-25', amountCents: 12345, currency: 'CAD', paidAt: null }, lines: [] } } });
    expect(page).toContain('lang="fr-CA"');
    expect(page).toContain(new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(123.45));
    expect(page).toContain('25 octobre 2026'); expect(page).not.toContain('2026-10-25');
  });
  it('reads assets once, and logs a missing asset once with an explicit unavailable error', async () => {
    const read = vi.fn(async () => 'built asset'), log = vi.fn();
    const asset = cachedLinkAsset('links.css', read, log);
    expect(await Promise.all([asset(), asset()])).toEqual(['built asset', 'built asset']);
    expect(read).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
    const missing = vi.fn(async (): Promise<string> => { throw new Error('ENOENT'); });
    const broken = cachedLinkAsset('links.js', missing, log);
    for (let i = 0; i < 2; i++) await expect(broken()).rejects.toMatchObject({ code: 'unavailable' });
    expect(missing).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
  });
});
