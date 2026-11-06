// SPDX-License-Identifier: AGPL-3.0-only
/** Propagates cancellation through body consumption, including after response headers arrived. */
export function abortableBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  return signal ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) : body;
}
