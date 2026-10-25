// SPDX-License-Identifier: AGPL-3.0-only
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * @param {URL} outputDirectory
 * @param {URL} entryPoint
 */
export async function buildServer(
  outputDirectory = new URL('./dist/', import.meta.url),
  entryPoint = new URL('./src/index.ts', import.meta.url),
) {
  await mkdir(outputDirectory, { recursive: true });
  const result = await build({
    entryPoints: [fileURLToPath(entryPoint)],
    outfile: fileURLToPath(new URL('./server.mjs', outputDirectory)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    legalComments: 'eof',
    metafile: true,
    banner: {
      js: [
        '// SPDX-License-Identifier: AGPL-3.0-only',
        'import { createRequire as __plaingymCreateRequire } from "node:module";',
        'const require = __plaingymCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  await cp(new URL('./src/assets/', import.meta.url), new URL('./assets/', outputDirectory), {
    recursive: true,
  });
  await cp(new URL('../../packs/', import.meta.url), new URL('./packs/', outputDirectory), { recursive: true });
  await cp(new URL('./src/infra/pdf/fonts/', import.meta.url), new URL('./assets/pdf/', outputDirectory), { recursive: true });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildServer();
}
