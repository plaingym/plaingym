// SPDX-License-Identifier: AGPL-3.0-only
import type { IncomingMessage } from 'node:http';

/** Server-rendered pages, their assets and Checkout returns must keep the sandbox Host and cookies.
 * With `demoEntryHost` (a demo install's `PUBLIC_ORIGIN` host), that host's `/` (the product page), `/demo` (its
 * redirect there) and `/demo-assets/` (the page's images and stylesheet) go to the server too. Other hosts keep them
 * on Vite, so ordinary dev roots and gym `/demo` start pages stay the SPA's. */
export function developmentProxy(port: string, demoEntryHost?: string) {
  const target = `http://127.0.0.1:${port}`;
  const proxy: Record<string, { target: string; changeOrigin: boolean; bypass?: (request: IncomingMessage) => string | undefined }> = Object.fromEntries(
    ['/healthz', '/api', '/source', '^/public/pages/', '^/l(?:[/?]|$)', '^/(?:join|trial|drop-in)(?:[/?]|$)', '^/webhooks(?:[/?]|$)']
      .map(path => [path, { target, changeOrigin: false }]));
  if (demoEntryHost) {
    // Returning the URL hands the request back to Vite; returning nothing proxies it.
    const entryOnly = (request: IncomingMessage) => request.headers.host?.toLowerCase() === demoEntryHost.toLowerCase() ? undefined : request.url;
    for (const path of ['^/(?:\\?|$)', '^/demo(?:\\?|$)', '^/demo-assets/']) proxy[path] = { target, changeOrigin: false, bypass: entryOnly };
  }
  return proxy;
}
