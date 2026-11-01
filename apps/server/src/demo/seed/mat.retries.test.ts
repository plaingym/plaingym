// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, emailOutbox, members, staffProfiles } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { matHarness } from './mat.fixture.test-helper.js';

const db = useTestDatabase();
const { fixture, counts } = matHarness(db);

// Two sandboxes and a rerun of the seed steps: the part of the mat checks that needs a second sandbox, kept apart from
// `mat.test.ts` so neither file passes a minute under full-suite load. The first sandbox is made in `beforeAll` to give
// it the longer hook timeout.
describe('demo mat seed retries', { timeout: 60_000 }, () => {
  let first: { f: ReturnType<typeof fixture>; sandbox: { gymId: string } };
  beforeAll(async () => {
    const f = fixture();
    first = { f, sandbox: await f.service.create() };
  }, 90_000);

  it('stays inside the sandbox gym, sends no email, writes no upload, and tolerates retries', async () => {
    // A second sandbox from the same service, as the first was created.
    const f = first.f, other = first.sandbox, before = await counts(other.gymId);
    const sandbox = await f.service.create();
    expect(await counts(other.gymId)).toEqual(before);
    const seeded = await counts(sandbox.gymId);
    expect(seeded.email_outbox).toBe(0);
    const photos = await db.forGym(sandbox.gymId, async (tx) => [...await tx.select({ key: members.photoKey }).from(members), ...await tx.select({ key: staffProfiles.photoKey }).from(staffProfiles)]);
    expect(photos.every((row) => row.key === null)).toBe(true);
    // Every audit names its own gym, and none of the other sandbox's rows moved.
    expect((await db.forGym(sandbox.gymId, (tx) => tx.select().from(auditEvents))).every((row) => row.gymId === sandbox.gymId)).toBe(true);

    // Rerunning the steps (as `gym-app seed` does) adds no duplicates, an hour later too.
    f.time.advance(60 * 60 * 1000);
    await f.seed({ gymId: sandbox.gymId, timezone: 'UTC', enabledModules: new Set() });
    const again = await counts(sandbox.gymId);
    for (const table of ['members', 'households', 'member_tags', 'member_tag_links', 'staff_profiles', 'class_templates', 'member_ranks', 'attendances'])
      expect(again[table], table).toBe(seeded[table]);
    expect(await db.forGym(sandbox.gymId, (tx) => tx.select().from(emailOutbox).where(eq(emailOutbox.gymId, sandbox.gymId)))).toEqual([]);
  });
});
