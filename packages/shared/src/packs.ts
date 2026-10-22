// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const named = { id, name: z.string().trim().min(1) };
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const rank = z.strictObject({
  ...named,
  color: color.optional(),
  subRanks: z.array(z.strictObject(named)).default([]),
});
export const contentPackSchema = z
  .strictObject({
    $comment: z.literal('SPDX-License-Identifier: AGPL-3.0-only').optional(),
    version: z.literal(1),
    ...named,
    summary: z.string().trim().min(1).optional(),
    rankSystems: z.array(z.strictObject({ ...named, ranks: z.array(rank).min(1) })),
    programs: z.array(z.strictObject({ ...named, rankSystemId: id.optional() })),
    classTags: z.array(z.strictObject(named)),
  })
  .superRefine((pack, context) => {
    const unique = (items: readonly { id: string }[], path: (string | number)[]) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.id))
          context.addIssue({ code: 'custom', message: 'Duplicate ID', path: [...path, index, 'id'] });
        seen.add(item.id);
      });
    };
    unique(pack.rankSystems, ['rankSystems']);
    unique(pack.programs, ['programs']);
    unique(pack.classTags, ['classTags']);
    pack.rankSystems.forEach((system, index) => {
      unique(system.ranks, ['rankSystems', index, 'ranks']);
      system.ranks.forEach((item, i) =>
        unique(item.subRanks, ['rankSystems', index, 'ranks', i, 'subRanks']),
      );
    });
    pack.programs.forEach((program, index) => {
      if (program.rankSystemId && !pack.rankSystems.some((system) => system.id === program.rankSystemId)) {
        context.addIssue({
          code: 'custom',
          message: 'Unknown rank system',
          path: ['programs', index, 'rankSystemId'],
        });
      }
    });
  });
export type ContentPack = z.infer<typeof contentPackSchema>;
