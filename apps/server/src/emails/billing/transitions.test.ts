// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { renderReceipt } from './transitions.js';

it('renders the receipt in the shared layout with the escaped gym name', async () => {
  const t = createTranslator(locales.en ?? {});
  const email = await renderReceipt({ gymName: '<b>Gym</b>', number: 7, amount: '$10.00' }, t);
  expect(email.subject).toBe('Receipt for invoice 7');
  expect(email.text).toContain('Receipt for invoice 7');
  expect(email.text).toContain('Payment of $10.00 received for invoice 7. Thank you.');
  expect(email.text).toContain(t('billing/transitions:receiptFooter'));
  expect(email.text).not.toContain('billing/transitions:');
  expect(email.html).toContain('<html');
  expect(email.html).toContain('&lt;b&gt;Gym&lt;/b&gt;');
  expect(email.html).not.toContain('<b>Gym');
});
