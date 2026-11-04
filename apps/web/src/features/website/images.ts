// SPDX-License-Identifier: AGPL-3.0-only
/** The server accepts images up to 512 KiB once decoded; stay a little under it. */
export const maxImageBytes = 500 * 1024;
export interface PreparedImage { readonly base64: string; readonly contentType: 'image/jpeg' | 'image/png' }

const decodedBytes = (base64: string) => Math.floor(base64.length * 3 / 4);
/**
 * Redraws a chosen image in the browser, so only fresh pixels are uploaded (no camera metadata) and the file fits the
 * upload limit: photos become JPEG at most `size` pixels on their long side, shrinking until they fit; a logo stays PNG
 * (keeping transparency) unless that is too large.
 */
export async function prepareImage(file: File, kind: 'photo' | 'logo'): Promise<PreparedImage> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) throw new Error('Invalid image');
  const bitmap = await createImageBitmap(file);
  try {
    for (let size = kind === 'logo' ? 512 : 1600, attempt = 0; attempt < 5; size = Math.round(size * 0.75), attempt++) {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing unavailable');
      const png = kind === 'logo' && attempt === 0;
      // A JPEG has no transparency: draw on white rather than black.
      if (!png) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const contentType = png ? 'image/png' : 'image/jpeg';
      const base64 = canvas.toDataURL(contentType, 0.82).split(',')[1] ?? '';
      if (base64 && decodedBytes(base64) <= maxImageBytes) return { base64, contentType };
    }
    throw new Error('Image too large');
  } finally { bitmap.close(); }
}
