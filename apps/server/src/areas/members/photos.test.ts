// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { maxPhotoBytes, validatePhoto } from './photos.js';
it('requires a bounded raster photo with a matching media type', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  expect(() => validatePhoto(png, 'image/png')).not.toThrow();
  expect(() => validatePhoto(png, 'image/jpeg')).toThrow();
  expect(() => validatePhoto(Buffer.from('<svg/>'), 'image/png')).toThrow();
  expect(() => validatePhoto(Buffer.from('<svg/>'), 'image/svg+xml')).toThrow();
  expect(() => validatePhoto(new Uint8Array(maxPhotoBytes + 1), 'image/png')).toThrow();
  expect(() => validatePhoto(new Uint8Array(), 'image/png')).toThrow();
});
