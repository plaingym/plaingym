// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { encryptSecret, parseEncryptionKey } from '../../core/secrets.js';
import { createGymKeyResolver } from './gym-keys.js';

const database = useTestDatabase(), factory = createFactories(database);
const key = parseEncryptionKey('cd'.repeat(32));

it('returns each gym\'s own random key and fails closed without one', async () => {
  const gymA = uuidv7(), gymB = uuidv7(), gymC = uuidv7(), secretA = randomBytes(32), secretB = randomBytes(32);
  await factory('gyms', gymA, { qrKey: encryptSecret(key, 'qr_key', secretA.toString('base64url')) });
  await factory('gyms', gymB, { qrKey: encryptSecret(key, 'qr_key', secretB.toString('base64url')) });
  await factory('gyms', gymC);
  const resolve = createGymKeyResolver({ key, scope: database.forGym });
  expect(Buffer.from(await resolve(gymA))).toEqual(secretA);
  expect(Buffer.from(await resolve(gymB))).toEqual(secretB);
  await expect(resolve(gymC)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(resolve(uuidv7())).rejects.toMatchObject({ code: 'unavailable' });
  // A different install key cannot decrypt it, and a short key is never accepted.
  await expect(createGymKeyResolver({ key: parseEncryptionKey('ef'.repeat(32)), scope: database.forGym })(gymA)).rejects.toThrow();
  const gymD = uuidv7();
  await factory('gyms', gymD, { qrKey: encryptSecret(key, 'qr_key', randomBytes(16).toString('base64url')) });
  await expect(resolve(gymD)).rejects.toMatchObject({ code: 'unavailable' });
});
