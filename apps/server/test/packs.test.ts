// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { contentPackSchema } from '@plaingym/shared';

const directory = new URL('../../../packs/', import.meta.url);
const packIds = ['bjj', 'judo', 'karate', 'muay-thai', 'functional-fitness'] as const;

async function loadPack(id: typeof packIds[number]) {
  const input: unknown = JSON.parse(await readFile(new URL(id + '.json', directory), 'utf8'));
  return contentPackSchema.parse(input);
}

describe('bundled discipline content packs', () => {
  it('ships exactly the five discipline packs with unique IDs', async () => {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
    expect(files).toEqual(packIds.map(id => id + '.json').sort());
    const packs = await Promise.all(packIds.map(loadPack));
    expect(new Set(packs.map(pack => pack.id)).size).toBe(packIds.length);
  });

  it.each(packIds)('%s loads from disk and satisfies the v1 schema', async id => {
    const pack = await loadPack(id);
    expect(pack.id).toBe(id);
    expect(pack.version).toBe(1);
    expect(pack.$comment).toBe('SPDX-License-Identifier: AGPL-3.0-only');
    expect(pack.programs.length).toBeGreaterThan(0);
    expect(pack.classTags.length).toBeGreaterThan(0);
    for (const system of pack.rankSystems) {
      for (const rank of system.ranks) expect(rank.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps the adult BJJ belt progression and stripe/degree counts', async () => {
    const pack = await loadPack('bjj');
    const system = pack.rankSystems.find(system => system.id === 'bjj-adult')!;
    expect(system.ranks.map(rank => rank.id)).toEqual([
      'white', 'blue', 'purple', 'brown', 'black', 'red-black', 'red-white', 'red',
    ]);
    expect(system.ranks.map(rank => rank.subRanks.length)).toEqual([4, 4, 4, 4, 6, 0, 0, 0]);
    expect(pack.programs.filter(program => program.id !== 'bjj-kids')
      .every(program => program.rankSystemId === system.id)).toBe(true);
  });

  it('gives kids BJJ its own youth progression without prescribing stripes', async () => {
    const pack = await loadPack('bjj');
    const system = pack.rankSystems.find(system => system.id === 'bjj-youth')!;
    expect(system.ranks.map(rank => rank.id)).toEqual([
      'white', 'grey-white', 'grey', 'grey-black', 'yellow-white', 'yellow', 'yellow-black',
      'orange-white', 'orange', 'orange-black', 'green-white', 'green', 'green-black',
    ]);
    expect(system.ranks.every(rank => rank.subRanks.length === 0)).toBe(true);
    expect(pack.programs.find(program => program.id === 'bjj-kids')?.rankSystemId).toBe(system.id);
  });

  it.each([
    { id: 'judo', kyuCount: 6 },
    { id: 'karate', kyuCount: 9 },
  ] as const)('$id orders kyu downward and dan upward', async ({ id, kyuCount }) => {
    const pack = await loadPack(id);
    expect(pack.rankSystems).toHaveLength(1);
    expect(pack.rankSystems[0]!.ranks.map(rank => rank.id)).toEqual([
      ...Array.from({ length: kyuCount }, (_, i) => 'kyu-' + (kyuCount - i)),
      ...Array.from({ length: 10 }, (_, i) => 'dan-' + (i + 1)),
    ]);
  });

  it.each(['muay-thai', 'functional-fitness'] as const)(
    '%s supplies classes without imposing a grading scheme',
    async id => {
      const pack = await loadPack(id);
      expect(pack.rankSystems).toEqual([]);
      expect(pack.programs.every(program => program.rankSystemId === undefined)).toBe(true);
    },
  );
});
