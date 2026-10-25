// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderWaiver } from './pdf.js';
import { pdfFixture } from './pdf.fixture.js';

it('rasterizes the embedded multilingual fonts with no system font substitution', async () => {
  const f = pdfFixture(), bytes = await renderWaiver(f.snapshot, f.snapshotHash, f.png);
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(viewport.width, viewport.height), context = canvas.getContext('2d');
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    expect(pixels.some((value, index) => index % 4 !== 3 && value < 100)).toBe(true);
    const directory = new URL('../../../../../coverage/waivers/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL('unicode.pdf', directory), bytes);
    await writeFile(new URL('unicode.png', directory), canvas.toBuffer('image/png'));
  } finally { await task.destroy(); }
});
