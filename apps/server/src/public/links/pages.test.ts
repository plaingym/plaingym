// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { linkPage } from './page.js';
import { checkoutReceipts } from './receipt.js';
import { setLogSink } from '../../core/log.js';
import { cachedLinkAsset } from './assets.js';
import messages from '../../../../../locales/en/public/links.json' with { type: 'json' };
const t = createTranslator({ 'public/links': messages });
const now = new Date('2026-10-25T12:00:00Z');
describe('signed-link presentation and return receipts', () => {
  it('frames only unsigned PDF templates after a signature', () => {
    const member = { id: 'member', firstName: 'Alex', lastName: 'Example', dateOfBirth: '2000-01-01', revision: 1 };
    const template = { name: 'Terms', kind: 'waiver' as const, version: 1, body: '', retiredAt: null, createdAt: now.toISOString(),
      document: { key: 'document.pdf', hash: 'a'.repeat(64), pages: 1, bytes: 100 } };
    const page = linkPage({ now, timezone: 'UTC', t, documentBase: '/l/token/documents/', data: { purpose: 'sign_waiver', member,
      templates: [{ ...template, id: 'signed' }, { ...template, id: 'unsigned' }], signatures: [{ id: 'signature', memberId: member.id,
        templateId: 'signed', snapshot: '{}', snapshotHash: '', signatureImageKey: '', signatureImageHash: '', signedAt: now.toISOString() }] } });
    expect(page.match(/<iframe/g)).toHaveLength(1);
    expect(page).toContain('src="/l/token/documents/unsigned"');
    expect(page).not.toContain('/l/token/documents/signed');
  });
  it.each(['USD', 'KWD'])('shows only the settlement note for a zero %s invoice', currency => {
    const page = linkPage({ now, timezone: 'UTC', t, data: { purpose: 'pay_invoice', invoice: { lines: [], invoice: {
      id: 'invoice', number: 1, kind: 'one_off', status: 'open', dueOn: '2026-10-25', amountCents: 0, currency, paidAt: null,
    } } } });
    expect(page).toContain('This invoice settles on its due date');
    expect(page).not.toContain('manual payment');
    expect(page).not.toContain('data-checkout');
  });
  it.each([[32, 'USD'], [1255, 'KWD']] as const)('shows manual payment instead of Checkout for %s %s', (amountCents, currency) => {
    const page = linkPage({ now, timezone: 'UTC', t, data: { purpose: 'pay_invoice', invoice: { lines: [], invoice: {
      id: 'invoice', number: 1, kind: 'one_off', status: 'open', dueOn: '2026-10-25', amountCents, currency, paidAt: null,
    } } } });
    expect(page).toContain('Contact the gym to arrange a manual payment');
    expect(page).not.toContain('data-checkout');
  });
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
  it('shows a zero-decimal gym\'s invoice in whole yen and a three-decimal one with three places', () => {
    const invoice = (currency: string, amountCents: number) => linkPage({ now, timezone: 'Asia/Tokyo', t, data: { purpose: 'pay_invoice',
      invoice: { invoice: { id: 'invoice', number: 1, kind: 'one_off', status: 'open', dueOn: '2026-10-25', amountCents, currency, paidAt: null },
        lines: [{ id: 'line', kind: 'charge', description: 'Mat fee', quantity: 1, amountCents, currency, taxRateMillionths: null, taxInclusive: null }] } } });
    const yen = invoice('JPY', 2500);
    expect(yen).toContain('¥2,500'); expect(yen).not.toContain('¥25.00'); expect(yen).not.toContain('¥25<');
    const dinar = invoice('KWD', 2500).replace(/\u00a0/g, ' ');
    expect(dinar).toContain('KWD 2.500'); expect(dinar).not.toContain('KWD 25.00');
  });
  it('reads assets once, and logs a missing asset once with an explicit unavailable error', async () => {
    const read = vi.fn(async () => 'built asset'), log = vi.fn(), previous = setLogSink(log);
    try {
      const asset = cachedLinkAsset('links.css', read);
      expect(await Promise.all([asset(), asset()])).toEqual(['built asset', 'built asset']);
      expect(read).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
      // The read error quotes a path, a database URL and a secret; none may reach the log line.
      const missing = vi.fn(async (): Promise<string> => { throw new Error('ENOENT: open /srv/SECRETPATH/links.js postgres://app:DBPASSWORD@db.invalid/gym token=rk_test_SECRETKEY'); });
      const broken = cachedLinkAsset('/srv/SECRETPATH/links.js', missing);
      for (let i = 0; i < 2; i++) await expect(broken()).rejects.toMatchObject({ code: 'unavailable' });
      expect(missing).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0]![0];
      expect(JSON.parse(line)).toMatchObject({ level: 'error', event: 'links.asset_unavailable', asset: 'links.js', error: { name: 'Error' } });
      expect(line).not.toMatch(/SECRETPATH|postgres:|DBPASSWORD|rk_test_SECRETKEY/);
    } finally { setLogSink(previous); }
  });
});
