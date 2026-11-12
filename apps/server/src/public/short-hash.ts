// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** A stable URL version derived from an immutable file key or rendered asset. */
export const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
/** A logo URL's version: the short hash of its immutable upload key, so it changes with the file and survives settings saves. */
export const logoVersion = (key: string) => shortHash(key);
