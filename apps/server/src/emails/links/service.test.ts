// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTranslator, type Translator } from '@plaingym/shared';
import { renderSignedLink, templates } from './service.js';

let t: Translator;
beforeAll(async () => {
  const messages = JSON.parse(await readFile(new URL('../../../../../locales/en/links/service.json', import.meta.url), 'utf8')) as Record<string, string>;
  t = createTranslator({ 'links/service': messages });
});
describe('signed link email', () => {
  it.each(['onboarding', 'pay_invoice', 'update_card', 'sign_waiver'] as const)('renders translated %s text and HTML in the shared layout', async (purpose) => {
    const url = 'https://gym.example.test/l/' + 'a'.repeat(43);
    const result = await renderSignedLink({ gymName: '<script>Gym</script>', url, purpose }, t);
    expect(result.subject).toBe(t(`links/service:${purpose}.subject`));
    expect(result.text).toContain(url);
    expect(result.text).toContain(t(`links/service:${purpose}.button`));
    expect(result.text).toContain(t('links/service:footer'));
    expect(result.html).toContain('&lt;script&gt;Gym&lt;/script&gt;');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('<html');
    expect(result.text).not.toContain('links/service:');
  });
  it('registers its template and rejects invalid template data and unsafe URLs', async () => {
    const template = templates[0]!;
    expect(template.id).toBe('links.service.signed-link');
    const input = { gymName: 'Test Gym', url: 'https://gym.example.test/l/token', purpose: 'pay_invoice' };
    expect(await template.render(input, t)).toEqual(await renderSignedLink({ ...input, purpose: 'pay_invoice' }, t));
    for (const invalid of [null, {}, { ...input, purpose: 'unknown' }, { ...input, url: 'javascript:alert(1)' }, { ...input, url: 'https://user:password@gym.example.test/' }])
      await expect(template.render(invalid, t)).rejects.toThrow();
  });
});