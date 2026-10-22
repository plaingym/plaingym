// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function inputPaths(ids, base) {
  const paths = new Set();
  for (const id of ids) {
    if (id.startsWith('\0')) continue; // Virtual modules have no files on disk.
    const path = resolve(base, id.split('?')[0]);
    if (existsSync(path)) paths.add(realpathSync(path));
  }
  return paths;
}

// Runs both production builds without publishing their output and returns the
// real paths of every input each bundle consumed, so evidence is never stale.
export async function bundleInputs(root) {
  const output = mkdtempSync(join(tmpdir(), 'plaingym-bundles-'));
  try {
    const { buildServer } = await import(pathToFileURL(join(root, 'apps/server/build.mjs')).href);
    const server = await buildServer(pathToFileURL(join(output, 'server') + '/'));
    const serverInputs = inputPaths(Object.keys(server.metafile.inputs), process.cwd());

    const web = join(root, 'apps/web');
    const { build } = await import(pathToFileURL(createRequire(join(web, 'package.json')).resolve('vite')).href);
    const ids = [];
    // The source link value cannot change which inputs are bundled.
    process.env.SOURCE_URL ||= 'https://example.invalid/compliance';
    await build({
      root: web,
      configFile: join(web, 'vite.config.ts'),
      logLevel: 'silent',
      build: { write: false, outDir: join(output, 'web'), emptyOutDir: false },
      plugins: [{
        name: 'plaingym-bundle-inputs',
        generateBundle(_, bundle) {
          for (const file of Object.values(bundle)) {
            ids.push(...(file.type === 'chunk' ? file.moduleIds : file.originalFileNames ?? []));
          }
        },
      }],
    });
    const webInputs = inputPaths(ids, web);
    if (!serverInputs.size || !webInputs.size) throw new Error('Bundle evidence is incomplete');
    return { server: serverInputs, web: webInputs };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
