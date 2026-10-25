// SPDX-License-Identifier: AGPL-3.0-only
import { buildServer } from '../../../build.mjs';
await buildServer(new URL('../../../../../coverage/waivers/pdf-bundle/', import.meta.url), new URL('./pdf-benchmark.ts', import.meta.url));
