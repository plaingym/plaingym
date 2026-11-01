// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createCheckinCodeService } from '../../areas/members/checkin-code.js';
import { pinKey, studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';

const { db, fixture } = useUnconfiguredSandbox();

it('gives a second sandbox from the same service its own student and QR key', async () => {
  const f = fixture(false), { gymId } = db.seeded, rows = await studentRows(db, gymId);
  const codes = createCheckinCodeService({ scope: db.forGym, clock: f.clock, gymKey: async () => pinKey });
  const { code } = await codes.read(gymId, rows.member.id);
  expect(await codes.resolve(gymId, code!)).toBe(rows.member.id);
  const other = await f.service.create();
  expect(await codes.resolve(other.gymId, code!)).toBeNull();
  expect((await studentRows(db, other.gymId)).member.id).not.toBe(rows.member.id);
}, 90_000);
