// SPDX-License-Identifier: AGPL-3.0-only
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/** NFKC is part of the durable password format. At most two 19 MiB native jobs run per process. */
export function createPasswordAdapter(concurrency = 2, maxQueue = 64) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Invalid password concurrency');
  let active = 0;
  const waiting: (() => void)[] = [];
  async function derive(password: string, salt: Buffer): Promise<Buffer> {
    if (Buffer.byteLength(password, 'utf8') > 4096) throw new Error('Password is too long');
    if (active >= concurrency) {
      if (waiting.length >= maxQueue) throw new Error('Password service is busy');
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else active++;
    try {
      return await new Promise<Buffer>((resolve, reject) => argon2('argon2id', {
        message: password.normalize('NFKC'), nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
      }, (error, hash) => error ? reject(error) : resolve(hash)));
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return {
    get active() { return active; },
    get queued() { return waiting.length; },
    async hash(password: string): Promise<string> {
      const salt = randomBytes(16);
      const hash = await derive(password, salt);
      return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64url').replaceAll('-', '+').replaceAll('_', '/')}$${hash.toString('base64url').replaceAll('-', '+').replaceAll('_', '/')}`;
    },
    async verify({ hash, password }: { hash: string; password: string }): Promise<boolean> {
      // Bound costs before allocating native memory; accept precisely the format we issue.
      const match = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/.exec(hash);
      if (!match) return false;
      const salt = Buffer.from(match[1]!, 'base64'), expected = Buffer.from(match[2]!, 'base64');
      if (salt.toString('base64').replace(/=+$/, '') !== match[1] || expected.toString('base64').replace(/=+$/, '') !== match[2]) return false;
      const actual = await derive(password, salt);
      return timingSafeEqual(actual, expected);
    },
  };
}
export const passwordAdapter = createPasswordAdapter();
