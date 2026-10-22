// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runInTransaction } from '@plaingym/shared/transaction';
import { decrypt, encrypt, generateIdentity, identityToRecipient, validateRecipient } from './index.js';
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
describe('age streaming wrapper', () => {
  it('round trips across multiple authenticated age chunks', async () => {
    const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
    const original = randomBytes(300_000);
    const ciphertext = new Uint8Array(await new Response(await encrypt(recipient, stream(original))).arrayBuffer());
    const plaintext = new Uint8Array(await new Response(await decrypt(identity, stream(ciphertext))).arrayBuffer());
    expect(plaintext).toEqual(new Uint8Array(original));
    expect(() => validateRecipient(identity)).toThrow();
    expect(() => validateRecipient('age1invalid')).toThrow();
  });
  it.each(['wrong-key', 'truncated', 'corrupt', 'reordered', 'trailing'])('rejects %s ciphertext', async (mode) => {
    const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
    let ciphertext = new Uint8Array(await new Response(await encrypt(recipient, stream(randomBytes(300_000)))).arrayBuffer());
    if (mode === 'truncated') ciphertext = ciphertext.slice(0, -1);
    if (mode === 'corrupt') ciphertext[ciphertext.length - 1]! ^= 1;
    if (mode === 'trailing') ciphertext = new Uint8Array(Buffer.concat([ciphertext, Buffer.from([0])]));
    if (mode === 'reordered') {
      const header = Buffer.from(ciphertext).indexOf(Buffer.from('\n', 'utf8'),
        Buffer.from(ciphertext).indexOf(Buffer.from('--- '))) + 1 + 16;
      const width = 65536 + 16;
      const first = ciphertext.slice(header, header + width), second = ciphertext.slice(header + width, header + 2 * width);
      ciphertext.set(second, header); ciphertext.set(first, header + width);
    }
    await expect((async () => new Response(await decrypt(mode === 'wrong-key' ? await generateIdentity() : identity, stream(ciphertext))).arrayBuffer())()).rejects.toThrow();
  });
  it('rejects encryption and decryption inside database transactions', async () => {
    const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
    await expect(runInTransaction(() => encrypt(recipient, stream(new Uint8Array())))).rejects.toThrow();
    await expect(runInTransaction(() => decrypt(identity, stream(new Uint8Array())))).rejects.toThrow();
  });
});
