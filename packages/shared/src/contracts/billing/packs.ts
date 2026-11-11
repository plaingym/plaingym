// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema, idSchema } from '../common.js';

/** The payer is derived from the member under lock; callers cannot choose another household. */
export const sellClassPackRequestSchema = z.strictObject({ memberId: idSchema, dueOn: dateSchema });
export type SellClassPackRequest = z.infer<typeof sellClassPackRequestSchema>;
