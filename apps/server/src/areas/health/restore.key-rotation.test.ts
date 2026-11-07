// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { describe, expect, inject, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { authAccount, encryptedFields, gyms, uuidv7 } from '@plaingym/db';
import { cloneDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertCatalog } from '../../../../../packages/db/src/security/catalog.js';
// Maintenance fixtures must not keep an app session connected during a rotation.
// eslint-disable-next-line no-restricted-imports
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { decryptSecret, encryptSecret, openSecret, type SecretClass, type SecretContext } from '../../core/secrets.js';
import { legacySecret } from '../../core/secrets.test-helper.js';
import { KeyRotationIncompleteError, PostgresMaintenance, UnreadableSecretsError } from './backups.database.js';

const oldKey = randomBytes(32), newKey = randomBytes(32);
const columns = {
  stripe_config: 'stripeConfig', smtp_config: 'smtpConfig', s3_config: 's3Config', qr_key: 'qrKey', backup_blob_key: 'backupBlobKey',
  google_config: 'googleConfig', oauth_access_token: 'accessToken', oauth_refresh_token: 'refreshToken', oauth_id_token: 'idToken',
} as const satisfies Record<SecretClass, string>;
const plaintext = (context: SecretContext) => 'private ' + context.secretClass + ' of ' + context.owner;
const contextOf = (where: string): SecretContext => {
  const [secretClass, owner] = where.split(':') as [SecretClass, string];
  return { secretClass, owner };
};
/**
 * An install of two gyms, each with a sign-in account, holding every secret class under `key`: some as v1 envelopes,
 * the rest as v2 ones, and one column left empty. Its own database, so a rotation sees only these rows.
 */
async function install(key: Buffer) {
  const clone = await cloneDatabase(inject('testDatabase'));
  const connection = openConnection(clone.maintenanceUrl, 1);
  const database = { ...clone, ...scopedDatabase(connection.db) }, make = createFactories(database);
  // In ID order, the order a rotation takes them in (UUIDv7s made in the same millisecond needn't be).
  const gymIds = [uuidv7(), uuidv7()].sort(), accountIds = [uuidv7(), uuidv7()].sort();
  const value = (secretClass: SecretClass, owner: string, legacy: boolean) =>
    legacy ? legacySecret(key, secretClass, plaintext({ secretClass, owner })) : encryptSecret(key, { secretClass, owner }, plaintext({ secretClass, owner }));
  for (const [index, gymId] of gymIds.entries()) {
    await make('gyms', gymId, { stripeConfig: value('stripe_config', gymId, index === 1), smtpConfig: value('smtp_config', gymId, true),
      s3Config: value('s3_config', gymId, false), qrKey: value('qr_key', gymId, index === 0), backupBlobKey: value('backup_blob_key', gymId, false),
      googleConfig: index === 0 ? value('google_config', gymId, false) : null });
    const accountId = accountIds[index]!;
    await make('authAccount', gymId, { id: accountId, accessToken: value('oauth_access_token', accountId, index === 0),
      refreshToken: value('oauth_refresh_token', accountId, true), idToken: value('oauth_id_token', accountId, false) });
  }
  /** Every stored value by `class:row`. */
  async function stored(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const rows = await database.forSystem(async (tx) => [...await tx.select().from(gyms), ...await tx.select().from(authAccount)]);
    for (const row of rows) for (const field of encryptedFields) {
      const value = (row as Record<string, unknown>)[columns[field.secretClass]];
      if (typeof value === 'string') result.set(field.secretClass + ':' + row.id, value);
    }
    return result;
  }
  return { database, gymIds, accountIds, stored, maintenance: new PostgresMaintenance(database.maintenanceUrl),
    cleanup: async () => { await connection.close(); await database.cleanup(); } };
}
type Install = Awaited<ReturnType<typeof install>>;
async function withInstall(key: Buffer, test: (install: Install) => Promise<void>) {
  const subject = await install(key);
  try { await test(subject); } finally {
    try { await subject.maintenance.restoreAppConnect(); } finally { await subject.cleanup(); }
  }
}
/** Each value opens as v2 with `key` in its own row, with its own plaintext, and not with `other`. */
function expectRotated(values: ReadonlyMap<string, string>, key: Buffer, other: Buffer) {
  for (const [where, value] of values) {
    const context = contextOf(where);
    const opened = openSecret(key, context, value);
    expect(opened.version === 'v2' && opened.plaintext === plaintext(context)).toBe(true);
    expect(() => decryptSecret(other, context, value)).toThrow('Unable to decrypt secret');
  }
}

describe('APP_ENCRYPTION_KEY rotation', { timeout: 60_000 }, () => {
  it('waits for an existing session, refuses before rewriting, and restores CONNECT', async () => {
    await withInstall(oldKey, async ({ database, maintenance, stored }) => {
      const app = openConnection(database.appUrl, 1), probe = openConnection(database.appUrl, 1);
      try {
        await app.sql`select 1`;
        const before = await stored();
        await expect(maintenance.rotateKey(oldKey, newKey)).rejects.toThrow('1 app sessions remain');
        expect(JSON.stringify([...(await stored())]) === JSON.stringify([...before])).toBe(true);
        await expect(probe.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        await maintenance.restoreAppConnect();
        await probe.sql`select 1`;
      } finally { await app.close(); await probe.close(); }
    });
  });

  it('retains the host fence after committed pages and restores it after a crash rerun', async () => {
    await withInstall(oldKey, async ({ database, maintenance, stored }) => {
      const probe = openConnection(database.appUrl, 1);
      try {
        await expect(maintenance.rotateKey(oldKey, newKey, () => { throw new Error('Interrupted'); }))
          .rejects.toThrow(KeyRotationIncompleteError);
        await expect(probe.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        // A new process can resume with CONNECT still revoked, then the host durably switches .env.
        const resumed = new PostgresMaintenance(database.maintenanceUrl);
        // A clean refusal in the next process must not release a prior attempt's fence.
        await expect(resumed.rotateKey(randomBytes(32), newKey)).rejects.toThrow(UnreadableSecretsError);
        await expect(probe.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        await resumed.rotateKey(oldKey, newKey);
        await expect(probe.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        await resumed.restoreAppConnect();
        await probe.sql`select 1`;
        expectRotated(await stored(), newKey, oldKey);
      } finally { await maintenance.restoreAppConnect(); await probe.close(); }
    });
  });

  it('continues once existing sessions close, without terminating them', async () => {
    await withInstall(oldKey, async ({ database, maintenance }) => {
      const app = openConnection(database.appUrl, 1), check = openConnection(database.maintenanceUrl, 1);
      let rotation: Promise<unknown> | undefined;
      try {
        await app.sql`select 1`;
        rotation = maintenance.rotateKey(oldKey, newKey);
        await vi.waitFor(async () => {
          const [row] = await check.sql`select has_database_privilege('app', current_database(), 'CONNECT') as allowed`;
          expect(row!.allowed).toBe(false);
        }, { timeout: 10_000 });
        await app.sql`select 1`;
        await app.close();
        await rotation;
      } finally { await app.close(); try { await rotation; } finally { await check.close(); } }
    });
  });

  it('keeps the fence when a session appears after the initial drain and reports a partial failure', async () => {
    await withInstall(oldKey, async ({ database, maintenance }) => {
      const app = openConnection(database.appUrl, 1);
      const probe = openConnection(database.appUrl, 1);
      try {
        let connected = false;
        await expect(maintenance.rotateKey(oldKey, newKey, async () => {
          if (connected) return;
          // Simulate a stray administrator grant admitting a connection after the first drain.
          await maintenance.restoreAppConnect();
          await app.sql`select 1`;
          const owner = openConnection(database.maintenanceUrl, 1);
          try { await owner.sql`revoke connect on database ${owner.sql(decodeURIComponent(new URL(database.maintenanceUrl).pathname.slice(1)))} from app`; }
          finally { await owner.close(); }
          connected = true;
        })).rejects.toThrow('App sessions appeared during key rotation; run rotate-key.sh again to finish with the same keys');
        await expect(probe.sql`select 1`).rejects.toMatchObject({ code: '42501' });
      } finally { await app.close(); await probe.close(); }
    });
  });

  it('preserves the cause of an unexpected failure after a committed page', async () => {
    await withInstall(oldKey, async ({ maintenance }) => {
      const cause = new Error('Injected failure');
      const error = await maintenance.rotateKey(oldKey, newKey, () => { throw cause; }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KeyRotationIncompleteError);
      expect((error as Error).cause === cause).toBe(true);
    });
  });

  it.each(['old-v1', 'old-v2', 'new-v1'] as const)('refuses a %s write into an already rotated row, then resumes', async (version) => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymId = gymIds[0]!, context = { secretClass: 'smtp_config', owner: gymId } as const;
      let commits = 0;
      await expect(maintenance.rotateKey(oldKey, newKey, async (table) => {
        if (table !== 'gyms' || ++commits !== 2) return;
        const value = version !== 'old-v2' ? legacySecret(version === 'new-v1' ? newKey : oldKey, 'smtp_config', plaintext(context))
          : encryptSecret(oldKey, context, plaintext(context));
        await database.forGym(gymId, (tx) => tx.update(gyms).set({ smtpConfig: value }).where(eq(gyms.id, gymId)));
      })).rejects.toThrow('A stored secret changed during key rotation; run rotate-key.sh again to finish with the same keys');
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(1);
      expectRotated(await stored(), newKey, oldKey);
    });
  });

  it('refuses a new app connection during rotation and restores CONNECT afterwards', async () => {
    await withInstall(oldKey, async ({ database, maintenance }) => {
      const app = openConnection(database.appUrl, 1);
      try {
        await maintenance.rotateKey(oldKey, newKey, async () => {
          await expect(app.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        });
        await expect(app.sql`select 1`).rejects.toMatchObject({ code: '42501' });
        await maintenance.restoreAppConnect();
        await app.sql`select 1`;
        await assertCatalog(app.sql);
      } finally { await app.close(); }
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(0);
    });
  });

  it('leaves pending backup credentials that neither key opens alone, in a rotation and in restore\'s re-key', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymId = gymIds[0]!;
      const stale = encryptSecret(randomBytes(32), { secretClass: 's3_config', owner: gymId }, 'pending under an earlier key');
      await database.forGym(gymId, (tx) => tx.update(gyms).set({ settings: { integrations: { backup: { s3Config: stale } } } })
        .where(eq(gyms.id, gymId)));
      const pending = async () => (await database.forSystem((tx) => tx.select().from(gyms).where(eq(gyms.id, gymId))))[0]!
        .settings as { integrations: { backup: { s3Config: string } } };
      await maintenance.rotateKey(oldKey, newKey);
      expectRotated(await stored(), newKey, oldKey);
      expect((await pending()).integrations.backup.s3Config === stale).toBe(true);
      await maintenance.rekey(newKey, oldKey, { now: () => new Date() });
      expectRotated(await stored(), oldKey, newKey);
      expect((await pending()).integrations.backup.s3Config === stale).toBe(true);
    });
  });

  it('re-encrypts every stored secret, v1 or v2, as v2 under the new key, each bound to its own row', async () => {
    await withInstall(oldKey, async ({ stored, maintenance, gymIds }) => {
      const before = await stored();
      expect(before.size).toBe(17);
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(17);
      const after = await stored();
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      expectRotated(after, newKey, oldKey);
      // Gym A's rotated value opens nowhere but in gym A's row and column.
      const stripeA = after.get('stripe_config:' + gymIds[0])!;
      expect(() => decryptSecret(newKey, { secretClass: 'stripe_config', owner: gymIds[1]! }, stripeA)).toThrow();
      expect(() => decryptSecret(newKey, { secretClass: 'smtp_config', owner: gymIds[0]! }, stripeA)).toThrow();
      // Done is done: running it again changes nothing.
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(0);
      expect(JSON.stringify([...(await stored())]) === JSON.stringify([...after])).toBe(true);
    });
  });

  it('resumes after a crash: what was committed stays, the rest follows, and the gyms come last', async () => {
    await withInstall(oldKey, async ({ stored, maintenance, gymIds, accountIds }) => {
      const before = await stored(), commits: string[] = [];
      // Power is lost after the second commit: the sign-in accounts (one page) and then the first gym.
      await expect(maintenance.rotateKey(oldKey, newKey, (table) => {
        commits.push(table);
        if (commits.length === 2) throw new Error('Power loss');
      })).rejects.toThrow(KeyRotationIncompleteError);
      expect(commits).toEqual(['auth_account', 'gyms']);
      const interrupted = await stored();
      for (const [where, value] of interrupted) {
        const context = contextOf(where), done = context.owner !== gymIds[1];
        expect(decryptSecret(done ? newKey : oldKey, context, value) === plaintext(context)).toBe(true);
        if (!done) expect(value === before.get(where)).toBe(true);
      }
      expect(accountIds.every((id) => interrupted.get('oauth_id_token:' + id) !== before.get('oauth_id_token:' + id))).toBe(true);
      // Run again with the same keys: only gym B's five values are left.
      expect((await maintenance.rotateKey(oldKey, newKey)).rewritten).toBe(5);
      const after = await stored();
      expectRotated(after, newKey, oldKey);
      for (const [where, value] of interrupted) if (contextOf(where).owner !== gymIds[1]) expect(after.get(where) === value).toBe(true);
    });
  });

  it('changes nothing with a wrong old key, and names each value it could not open, never the value', async () => {
    await withInstall(oldKey, async ({ stored, maintenance }) => {
      const before = await stored(), wrong = randomBytes(32);
      const error = await maintenance.rotateKey(wrong, newKey).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnreadableSecretsError);
      const { unreadable, message } = error as UnreadableSecretsError;
      expect(unreadable.map((value) => value.secretClass + ':' + value.owner).sort()).toEqual([...before.keys()].sort());
      expect(message).toBe('Stored secrets open with neither key');
      for (const key of [oldKey, newKey, wrong]) expect(JSON.stringify({ message, unreadable }).includes(key.toString('hex'))).toBe(false);
      expect(JSON.stringify([...(await stored())]) === JSON.stringify([...before])).toBe(true);
    });
  });

  it('refuses a value copied into another gym\'s row before changing any gym, and names that row', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const [gymA, gymB] = gymIds as [string, string];
      const stripeA = (await stored()).get('stripe_config:' + gymA)!;
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: stripeA }).where(eq(gyms.id, gymB)));
      const before = await stored();
      const error = await maintenance.rotateKey(oldKey, newKey).catch((caught: unknown) => caught);
      expect((error as UnreadableSecretsError).unreadable).toEqual([{ secretClass: 'stripe_config', owner: gymB }]);
      expect(JSON.stringify([...(await stored())]) === JSON.stringify([...before])).toBe(true);
      // Once gym B's row holds its own value again, the rotation goes through.
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: encryptSecret(oldKey, { secretClass: 'stripe_config', owner: gymB },
        plaintext({ secretClass: 'stripe_config', owner: gymB })) }).where(eq(gyms.id, gymB)));
      await maintenance.rotateKey(oldKey, newKey);
      expectRotated(await stored(), newKey, oldKey);
    });
  });

  it('stops without claiming nothing changed when a value changes after its check, and finishes when run again', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymB = gymIds[1]!, stripe = { secretClass: 'stripe_config', owner: gymB } as const;
      const set = (value: string) => database.forGym(gymB, (tx) => tx.update(gyms).set({ stripeConfig: value }).where(eq(gyms.id, gymB)));
      // Something still running writes gym B's Stripe settings under another key after the check passed.
      const error = await maintenance.rotateKey(oldKey, newKey, async (table) => {
        if (table === 'auth_account') await set(encryptSecret(randomBytes(32), stripe, 'written meanwhile'));
      }).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(UnreadableSecretsError);
      expect(error).toBeInstanceOf(KeyRotationIncompleteError);
      expect((error as Error).message).toBe('Key rotation stopped while rewriting stored secrets; run rotate-key.sh again to finish with the same keys');
      expect(((error as Error).cause as Error).message).toBe('A stored secret changed during the key rotation');
      // What committed before stays rotated; gym B's row is untouched.
      const interrupted = await stored();
      expect(openSecret(newKey, { secretClass: 'qr_key', owner: gymIds[0]! }, interrupted.get('qr_key:' + gymIds[0])!).version).toBe('v2');
      expect(decryptSecret(oldKey, { secretClass: 'qr_key', owner: gymB }, interrupted.get('qr_key:' + gymB)!) === plaintext({ secretClass: 'qr_key', owner: gymB })).toBe(true);
      await set(encryptSecret(oldKey, stripe, plaintext(stripe)));
      await maintenance.rotateKey(oldKey, newKey);
      expectRotated(await stored(), newKey, oldKey);
    });
  });

  it('waits for a running backup, which holds the backup lock, and refuses one key twice', async () => {
    await withInstall(oldKey, async ({ maintenance }) => {
      await expect(maintenance.rotateKey(oldKey, Buffer.from(oldKey))).rejects.toThrow('two different keys');
      let rotated = false, rotation: Promise<unknown> | undefined;
      await maintenance.locked(async () => {
        rotation = maintenance.rotateKey(oldKey, newKey).then(() => { rotated = true; });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(rotated).toBe(false);
      });
      await rotation;
      expect(rotated).toBe(true);
    });
  });
});

describe('the one-time v1 to v2 rewrite after migrations', { timeout: 60_000 }, () => {
  it('rewrites v1 values as v2 under the same key, and leaves v2 values and ones the key cannot open', async () => {
    await withInstall(oldKey, async ({ database, stored, maintenance, gymIds }) => {
      const gymB = gymIds[1]!, unreadable = legacySecret(randomBytes(32), 'qr_key', 'under another key');
      await database.forGym(gymB, (tx) => tx.update(gyms).set({ qrKey: unreadable }).where(eq(gyms.id, gymB)));
      const before = await stored(), legacy = [...before].filter(([, value]) => value.startsWith('v1.'));
      expect(legacy.length).toBe(8);
      expect(await maintenance.upgradeSecrets(oldKey)).toEqual({ rewritten: 7, unreadable: 1 });
      const after = await stored();
      for (const [where, value] of after) {
        if (where === 'qr_key:' + gymB) { expect(value === unreadable).toBe(true); continue; }
        const context = contextOf(where);
        const opened = openSecret(oldKey, context, value);
        expect(opened.version === 'v2' && opened.plaintext === plaintext(context)).toBe(true);
        if (!before.get(where)!.startsWith('v1.')) expect(value === before.get(where)).toBe(true);
      }
      // Each rewritten value is now bound to its gym: gym B's former v1 Stripe settings don't open in gym A's row.
      expect(() => decryptSecret(oldKey, { secretClass: 'stripe_config', owner: gymIds[0]! }, after.get('stripe_config:' + gymB)!)).toThrow();
      // Nothing more to do on the next start; the unreadable value is counted again and left alone.
      expect(await maintenance.upgradeSecrets(oldKey)).toEqual({ rewritten: 0, unreadable: 1 });
      expect(JSON.stringify([...(await stored())]) === JSON.stringify([...after])).toBe(true);
    });
  });
});
