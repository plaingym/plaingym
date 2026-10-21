// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const sourceUrl = process.env.SOURCE_URL || env.SOURCE_URL;
  if (!sourceUrl) throw new Error('Set SOURCE_URL to the public source URL for this checkout.');
  if (!['https:', 'http:'].includes(new URL(sourceUrl).protocol)) {
    throw new Error('SOURCE_URL must be an HTTP(S) URL.');
  }
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      proxy: { '/healthz': `http://127.0.0.1:${env.PORT || '3000'}` },
    },
    define: {
      __SOURCE_URL__: JSON.stringify(sourceUrl),
    },
  };
});
