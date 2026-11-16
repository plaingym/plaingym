// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { parseSignatureImageKey } from './signature-image-key.js';

it('extracts each owner from an exact signature key and refuses malformed or extended paths', () => {
  const gymId = uuidv7(), memberId = uuidv7(), imageId = uuidv7();
  const key = `${gymId}/waivers/${memberId}/signatures/${imageId}.png`;
  expect(parseSignatureImageKey(key)).toEqual({ gymId, memberId, imageId });
  for (const invalid of [key + '\n', key + '/child', key.replace('.png', '.pdf'), key.replace(memberId, '-'.repeat(36)), '../' + key])
    expect(parseSignatureImageKey(invalid)).toBeUndefined();
});
