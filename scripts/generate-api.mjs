// SPDX-License-Identifier: AGPL-3.0-only
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sharedRequire = createRequire(new URL('../packages/shared/package.json', import.meta.url));
const { default: openapiTS, astToString } = await import(
  pathToFileURL(sharedRequire.resolve('openapi-typescript')).href
);

/** @param {object} document @returns {Promise<string>} */
export async function generateApiSource(document) {
  const types = astToString(await openapiTS(document));
  return `// SPDX-License-Identifier: AGPL-3.0-only
import createClient, { type ClientOptions } from 'openapi-fetch';

${types}
export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>(options);
}
`;
}
