// SPDX-License-Identifier: AGPL-3.0-only
import { build } from 'esbuild';
import { buildInfo } from '../../../../scripts/release/version.mjs';
await build({
  entryPoints: ['src/cli/restore.entry.ts'], outfile: 'dist/maintenance.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: true, legalComments: 'eof',
  define: { __BUILD_INFO__: JSON.stringify(buildInfo()) },
  banner: { js: '// SPDX-License-Identifier: AGPL-3.0-only\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
