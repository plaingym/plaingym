// SPDX-License-Identifier: AGPL-3.0-only
/** Re-encode browser-decoded images to strip metadata and bound stored dimensions. */
export async function resizeStaffPhoto(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Invalid photo');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Photo resizing unavailable');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Photo resizing failed')), 'image/jpeg', 0.85));
    if (blob.size > 512 * 1024) throw new Error('Photo too large');
    return new File([blob], 'staff-photo.jpg', { type: 'image/jpeg' });
  } finally { bitmap.close(); }
}
