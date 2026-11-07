// SPDX-License-Identifier: AGPL-3.0-only
/** In-process requests lack the Content-Length that browsers send for buffered forms and JSON. */
export async function requestWithLength(url: string, init: RequestInit): Promise<Request> {
  const request = new Request(url, init);
  const body = await request.arrayBuffer();
  request.headers.set('content-length', String(body.byteLength));
  return new Request(url, { ...init, headers: request.headers, body });
}
