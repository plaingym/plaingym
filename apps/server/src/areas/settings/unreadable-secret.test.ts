// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { setLogSink } from '../../core/log.js';
import { readStoredSecret } from './unreadable-secret.js';

it('isolates failures by key, secret class, owner and ciphertext and forgets removed values', () => {
  const key = Buffer.alloc(32), lines: string[] = [];
  const previous = setLogSink((line) => lines.push(line));
  const read = vi.fn(() => { throw new Error('sensitive message'); });
  try {
    for (let i = 0; i < 3; i++) expect(readStoredSecret(key, 'smtp_config', 'a', 'ciphertext', read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    readStoredSecret(key, 'google_config', 'a', 'ciphertext', read);
    readStoredSecret(key, 'smtp_config', 'b', 'ciphertext', read);
    readStoredSecret(key, 'smtp_config', 'a', 'new-ciphertext', read);
    readStoredSecret(Buffer.from(key), 'smtp_config', 'a', 'new-ciphertext', read);
    expect(read).toHaveBeenCalledTimes(5);
    readStoredSecret(key, 'smtp_config', 'a', null, read);
    readStoredSecret(key, 'smtp_config', 'a', 'new-ciphertext', read);
    expect(read).toHaveBeenCalledTimes(6);
    expect(lines.join('')).not.toMatch(/sensitive message|ciphertext/);
  } finally { setLogSink(previous); }
});
