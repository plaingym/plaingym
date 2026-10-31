// SPDX-License-Identifier: AGPL-3.0-only
/** Server-rendered pages, their assets and Checkout returns must keep the sandbox Host and cookies. */
export function developmentProxy(port: string) {
  return Object.fromEntries(['/healthz', '/api', '/source', '^/public/pages/', '^/l(?:[/?]|$)', '^/(?:join|trial|drop-in)(?:[/?]|$)', '^/webhooks(?:[/?]|$)']
    .map(path => [path, { target: `http://127.0.0.1:${port}`, changeOrigin: false }]));
}
