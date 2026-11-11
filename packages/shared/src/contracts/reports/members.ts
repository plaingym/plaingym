// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Counts member activity transitions, after unioning overlapping memberships. */
export const membersReportCountsSchema = z.strictObject({
  activeAtStart: z.int().nonnegative(),
  new: z.int().nonnegative(),
  imported: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  netChange: z.int(),
  activeAtEnd: z.int().nonnegative(),
  frozenAtEnd: z.int().nonnegative(),
  churn: z.strictObject({ numerator: z.int().nonnegative(), denominator: z.int().positive() }).nullable(),
});
