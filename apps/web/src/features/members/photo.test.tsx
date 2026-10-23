// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { resizeMemberPhoto } from './api.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('scales large photos proportionally and encodes fresh JPEG pixels before upload', async () => {
  const close = vi.fn(), drawImage = vi.fn(), fillRect = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2000, height: 1000, close })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,Ynl0ZXM=');
  expect(await resizeMemberPhoto(new File(['original EXIF bytes'], 'photo.png', { type: 'image/png' }))).toBe('Ynl0ZXM=');
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
  expect(encode).toHaveBeenCalledWith('image/jpeg', 0.85); expect(close).toHaveBeenCalled();
});
it('rejects SVG and oversized original files before decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(resizeMemberPhoto(new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' }))).rejects.toThrow();
  await expect(resizeMemberPhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' }))).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});
