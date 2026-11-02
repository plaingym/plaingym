// SPDX-License-Identifier: AGPL-3.0-only
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The public files that render markup, `page.ts` and `*.page.ts` anywhere under `public/`, so a class used in any public page compiles.
 * Services, jobs and notices are left out: their identifiers would otherwise match a utility and emit CSS.
 * @param {string} [root] the directory to scan, `public/` by default
 * @returns {Promise<string[]>} absolute paths, sorted */
export async function linkStyleSources(root = fileURLToPath(new URL('..', import.meta.url))) {
  const files = await readdir(root, { recursive: true });
  return files.filter(file => /(^|[\\/])([^\\/]+\.)?page\.ts$/.test(file)).sort().map(file => join(root, file));
}
/** Build with the web app's already-pinned Tailwind toolchain and shared tokens.
 * @param {string} destination
 * @param {string[]} [files] the source files to scan, `linkStyleSources()` by default */
export async function buildLinkStyles(destination, files) {
  const cssPath = fileURLToPath(new URL('../../../../web/src/app/styles.css', import.meta.url));
  const css = await readFile(cssPath, 'utf8');
  const compiler = await compile(css, { base: dirname(cssPath), onDependency() {} });
  const sources = await Promise.all((files ?? await linkStyleSources()).map(file => readFile(file, 'utf8')));
  const candidates = sources.flatMap(source => source.match(/[A-Za-z0-9_:!./%[\]()-]+/g) ?? []);
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
