// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { developmentProxy } from './dev-proxy.js';
import { buildInfo } from '../../scripts/release/version.mjs';

/** The theme must apply before the first paint and the SPA's CSP allows no inline script, so the early
 * script stays a blocking classic file. The build emits its source under /assets/ with a content hash
 * (cached immutably); `pnpm dev` serves the source path from the tag in index.html. */
function earlyThemeScript(): Plugin {
  const sourcePath = fileURLToPath(new URL('./src/lib/theme-init.js', import.meta.url));
  const asset = () => {
    const source = readFileSync(sourcePath, 'utf8');
    return { source, fileName: 'assets/theme-init-' + createHash('sha256').update(source).digest('hex').slice(0, 16) + '.js' };
  };
  return {
    name: 'early-theme-script',
    generateBundle() {
      const { source, fileName } = asset();
      this.emitFile({ type: 'asset', fileName, source });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.bundle) return html;
        return html.replace(/<script\b[^>]*\bsrc="\/src\/lib\/theme-init\.js"[^>]*><\/script>/i,
          '<script src="/' + asset().fileName + '"></script>');
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const sourceUrl = process.env.SOURCE_URL || env.SOURCE_URL;
  if (!sourceUrl) throw new Error('Set SOURCE_URL to the public source URL for this checkout.');
  if (!['https:', 'http:'].includes(new URL(sourceUrl).protocol)) {
    throw new Error('SOURCE_URL must be an HTTP(S) URL.');
  }
  return {
    plugins: [
      earlyThemeScript(),
      tanstackRouter({
        target: 'react',
        routesDirectory: fileURLToPath(new URL('./src/routes', import.meta.url)),
        generatedRouteTree: fileURLToPath(new URL('./src/routeTree.gen.ts', import.meta.url)),
        tmpDir: fileURLToPath(new URL('./dist/.tanstack', import.meta.url)),
        routeTreeFileHeader: ['// SPDX-License-Identifier: AGPL-3.0-only', '// @ts-nocheck'],
        quoteStyle: 'single',
        semicolons: true,
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    server: {
      // Native Linux Docker may need VITE_HOST=0.0.0.0 to reach the host dev server.
      host: env.VITE_HOST || '127.0.0.1',
      // Keep the browser's Host: the auth handler only serves the gym's own host (PUBLIC_ORIGIN).
      // A demo install's entry host (PUBLIC_ORIGIN, else the demo domain, as the server reads it) gets the
      // server-rendered product page at its root.
      proxy: developmentProxy(env.PORT || '3000', env.DEMO_MODE === 'true' && (env.PUBLIC_ORIGIN || env.DEMO_DOMAIN)
        ? new URL(env.PUBLIC_ORIGIN || `https://${env.DEMO_DOMAIN}`).host : undefined),
    },
    define: {
      __SOURCE_URL__: JSON.stringify(sourceUrl),
      __BUILD_INFO__: JSON.stringify(buildInfo()),
    },
  };
});
