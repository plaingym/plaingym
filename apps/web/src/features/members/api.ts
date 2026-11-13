// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse, type ResponseSchema } from '../../lib/response.js';
import { ApiError, apiErrorReasons } from '../../lib/api.js';

/** Fetches a members endpoint and validates its JSON response with the shared contract schema. */
export async function memberRequest<T>(schema: ResponseSchema<T>, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  // Reason codes (never server messages) let a screen explain a refusal, such as a member delete refused for billing records.
  if (!response.ok) throw new ApiError(response.status, response.status === 409 ? 'conflict' : 'request_failed', await apiErrorReasons(response));
  return parseResponse(schema, await response.json());
}

/** Decode and resize before uploading; raster encoding drops metadata such as EXIF location. */
export async function resizeMemberPhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Invalid photo');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing unavailable');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]!;
  } finally { bitmap.close(); }
}
