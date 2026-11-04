// SPDX-License-Identifier: AGPL-3.0-only
// Records a named moment on the sampler's clock: `docker exec <sampler> node /harness/mark.mjs ready`.
import { appendFileSync } from 'node:fs';

const name = process.argv[2];
if (!name) throw new Error('Usage: mark.mjs NAME');
appendFileSync(process.env.MARKS_OUT ?? '/out/marks.jsonl', JSON.stringify({ mark: name, at: Date.now() }) + '\n');
