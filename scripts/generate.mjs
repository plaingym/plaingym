// SPDX-License-Identifier: AGPL-3.0-only
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { loadLocale } from '../locales/loader.ts';
import { generateApiSource } from './generate-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = join(root, 'apps/web');
const webRequire = createRequire(join(webRoot, 'package.json'));
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const generatorManifest = webRequire.resolve('@tanstack/router-generator/package.json');
const generatorPackage = JSON.parse(await readFile(generatorManifest, 'utf8'));
const { Generator, getConfig } = await import(
  pathToFileURL(join(dirname(generatorManifest), generatorPackage.module)).href
);
const { OpenAPIHono } = await import(pathToFileURL(serverRequire.resolve('@hono/zod-openapi')).href);
const header = '// SPDX-License-Identifier: AGPL-3.0-only';

/** @param {string} path @param {string} contents */
async function writeChanged(path, contents) {
  let previous;
  try {
    previous = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (previous === contents) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

await new Generator({
  root: webRoot,
  config: getConfig(
    {
      target: 'react',
      routesDirectory: join(webRoot, 'src/routes'),
      generatedRouteTree: join(webRoot, 'src/routeTree.gen.ts'),
      tmpDir: join(webRoot, 'dist/.tanstack'),
      routeTreeFileHeader: [header, '// @ts-nocheck'],
      quoteStyle: 'single',
      semicolons: true,
      disableLogging: true,
    },
    webRoot,
  ),
}).run();

/** @type {Record<string, unknown>} */
const localeFiles = {};
const localeRoot = join(root, 'locales');
for (const path of (await readdir(localeRoot, { recursive: true })).sort()) {
  if (!path.endsWith('.json')) continue;
  localeFiles[path.replaceAll('\\', '/')] = JSON.parse(await readFile(join(localeRoot, path), 'utf8'));
}
const languages = [...new Set(Object.keys(localeFiles).map((path) => path.split('/')[0]))];
const catalogs = Object.fromEntries(languages.map((language) => [language, loadLocale(localeFiles, language)]));
await writeChanged(join(root, 'packages/shared/dist/locales.gen.ts'), header +
  "\nimport type { LocaleCatalog } from '../src/i18n.js';\n\nexport const locales: Readonly<Record<string, LocaleCatalog>> = " +
  JSON.stringify(catalogs, null, 2) + ';\n');
// Routes import email templates, which need the generated locales even on a clean checkout.
const { areaContributions } = await import('../apps/server/src/core/registry-areas.ts');
const { createServerRegistry } = await import('../apps/server/src/core/registry.ts');
// Load module descriptors at composition time; core never imports module code.
const modulesDirectory = join(root, 'apps/server/src/modules');
const modules = [];
for (const entry of (await readdir(modulesDirectory, { withFileTypes: true })).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory()) continue;
  const descriptor = await import(pathToFileURL(join(modulesDirectory, entry.name, 'index.ts')).href);
  for (const value of Object.values(descriptor)) {
    if (value && typeof value === 'object' && 'schemaFile' in value && 'id' in value) modules.push(value);
  }
}
const registry = createServerRegistry({ ...areaContributions, modules });
const app = new OpenAPIHono();
// Generation registers handlers without executing requests or contacting infrastructure.
registry.mount(
  app,
  () => async (_context, next) => {
    await next();
  },
  new Set(modules.map((module) => module.id)),
);
const document = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'PlainGym API', version: '0.0.0' },
});
await writeChanged(join(root, 'packages/shared/dist/api-client.gen.ts'), await generateApiSource(document));

console.log('Generated route tree, OpenAPI client, and locales.');
