// SPDX-License-Identifier: AGPL-3.0-only
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build with the web app's already-pinned Tailwind toolchain and shared tokens.
 * @param {string} destination */
export async function buildLinkStyles(destination) {
  const cssPath = fileURLToPath(new URL('../../../../web/src/app/styles.css', import.meta.url));
  const css = await readFile(cssPath, 'utf8');
  const compiler = await compile(css, { base: dirname(cssPath), onDependency() {} });
  const source = await readFile(new URL('./page.ts', import.meta.url), 'utf8');
  const candidates = source.match(/[A-Za-z0-9_:!./%[\]()-]+/g) ?? [];
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, compiler.build(candidates));
}
/** @param {string} destination */
export async function buildLinkAssets(destination) {
  await buildLinkStyles(join(destination, 'links.css'));
  const result = await build({ stdin: { contents: 'import { linkBrowser } from "./browser.ts"; linkBrowser();',
    resolveDir: dirname(fileURLToPath(import.meta.url)), sourcefile: 'signed-link-client.ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'eof' });
  const script = result.outputFiles[0];
  if (!script) throw new Error('Signed-link browser build produced no output');
  await writeFile(join(destination, 'links.js'), script.text);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLinkAssets(resolve(process.argv[2] ?? 'apps/web/dist'));
}
