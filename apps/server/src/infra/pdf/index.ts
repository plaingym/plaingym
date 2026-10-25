// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { create } from 'fontkit';
import type { Font } from 'fontkit';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import { AppError } from '@plaingym/shared';
import provenance from './fonts/provenance.json' with { type: 'json' };
import coverage from './coverage.json' with { type: 'json' };

const bidi = bidiFactory(), graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const words = new Intl.Segmenter('und', { granularity: 'word' });
const parsed = new Map<number, Font>();
if (coverage.length !== provenance.length || coverage.some((entry, i) => entry.sha256 !== provenance[i]!.sha256)) throw new Error('PDF coverage integrity failure');
function covers(index: number, point: number) {
  const ranges = coverage[index]!.ranges;
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1, range = ranges[mid]!;
    if (point < range[0]!) high = mid - 1;
    else if (point > range[1]!) low = mid + 1;
    else return true;
  }
  return false;
}
function font(index: number): Font {
  if (!parsed.has(index)) {
    const entry = provenance[index]!;
    const source = new URL('./fonts/' + entry.file, import.meta.url);
    const bytes = readFileSync(existsSync(source) ? source : new URL('./assets/pdf/' + entry.file, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('PDF font integrity failure');
    const font = create(bytes); if (!('layout' in font)) throw new Error('Expected a single font');
    parsed.set(index, font);
  }
  return parsed.get(index)!;
}
/** Diagnostics expose only asset names, never parsed vendor objects. */
export const loadedFontFiles = () => [...parsed.keys()].map(index => provenance[index]!.file);
// @types/pdfkit has not yet modelled PDFKit 0.20.2's public parsed-font input.
// Keep the adaptation at this boundary; each document still owns its subset.
const pdfFont = (font: Font) => font as unknown as Buffer;
function fontFor(text: string) {
  const points = [...text].map(c => c.codePointAt(0)!);
  return coverage.findIndex((_entry, index) => points.every(p => covers(index, p)));
}
const replacements = (text: string) => [...text].map(c => fontFor(c) < 0 ? '\uFFFD' : c).join('');
interface Run { text: string; font: number; level: number; index: number }
function runs(text: string, direction?: 'ltr' | 'rtl') {
  const embedding = bidi.getEmbeddingLevels(text, direction), mirror = bidi.getMirroredCharactersMap(text, embedding);
  const logical: Run[] = [];
  for (const part of graphemes.segment(text)) {
    let index = part.index;
    const value = [...part.segment].map(c => { const mirrored = mirror.get(index) ?? c; index += c.length; return mirrored; }).join('');
    index = part.index;
    // Keep normal graphemes intact. If no face covers a whole cluster, preserve
    // its supported code points using separate faces instead of dropping it.
    for (const segment of fontFor(value) >= 0 ? [value] : [...value]) {
      const level = embedding.levels[index]!, previous = logical.at(-1);
      const font = /^\s+$/u.test(segment) && previous && fontFor(segment) >= 0 ? previous.font : Math.max(0, fontFor(segment));
      // Even-level digits in an Arabic font must be shaped individually: otherwise
      // fontkit infers Arabic direction and reverses their order a second time.
      if (previous && previous.level === level && previous.font === font && !(level % 2 === 0 && /\p{Number}/u.test(segment))) previous.text += segment;
      else logical.push({ text: segment, font, level, index });
      index += segment.length;
    }
  }
  const visual = Array.from({ length: text.length }, (_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(text, embedding)) {
    const reversed = visual.slice(start, end + 1).reverse(); visual.splice(start, reversed.length, ...reversed);
  }
  const positions = new Map(visual.map((value, i) => [value, i]));
  return { rtl: (embedding.paragraphs[0]?.level ?? 0) % 2 === 1,
    runs: logical.sort((a, b) => positions.get(a.index)! - positions.get(b.index)!) };
}
const measurements = new WeakMap<PDFKit.PDFDocument, Map<string, number>>();
const registered = new WeakMap<PDFKit.PDFDocument, Set<number>>();
function selectFont(doc: PDFKit.PDFDocument, index: number) {
  let fonts = registered.get(doc);
  if (!fonts) { fonts = new Set(); registered.set(doc, fonts); }
  if (!fonts.has(index)) { doc.registerFont('noto' + index, pdfFont(font(index))); fonts.add(index); }
  return doc.font('noto' + index);
}
function runWidth(doc: PDFKit.PDFDocument, run: Run, size: number) {
  let cache = measurements.get(doc);
  if (!cache) { cache = new Map(); measurements.set(doc, cache); }
  const key = JSON.stringify([run.font, size, run.text]);
  const prior = cache.get(key); if (prior !== undefined) return prior;
  const value = selectFont(doc, run.font).fontSize(size).widthOfString(run.text, { features: [] });
  if (cache.size >= 2048) cache.clear();
  cache.set(key, value); return value;
}
function width(doc: PDFKit.PDFDocument, text: string, size: number) {
  return runs(text).runs.reduce((total, r) => total + runWidth(doc, r, size), 0);
}
function drawLine(doc: PDFKit.PDFDocument, text: string, y: number, size = 11, direction?: 'ltr' | 'rtl') {
  const layout = runs(text, direction), lineWidth = layout.runs.reduce((sum, run) => sum + runWidth(doc, run, size), 0);
  let x = layout.rtl ? 564 - lineWidth : 48;
  const positioned = layout.runs.map(run => {
    const start = x;
    x += runWidth(doc, run, size);
    return { run, start };
  });
  // Paint in logical order while retaining visual coordinates. PDF text readers
  // can recover mixed-script logical order without reversing numeric runs.
  for (const { run, start } of positioned.sort((a, b) => a.run.index - b.run.index)) {
    selectFont(doc, run.font).fontSize(size);
    doc.text(run.text, start, y, { lineBreak: false, features: [] });
  }
}
function wrapLines(doc: PDFKit.PDFDocument, paragraph: string, size: number) {
  const result: string[] = []; let line = '', lineWidth = 0;
  for (const word of words.segment(paragraph)) {
    const wordWidth = width(doc, word.segment, size);
    if (lineWidth + wordWidth <= 510) { line += word.segment; lineWidth += wordWidth; continue; }
    if (line) { result.push(line); line = ''; lineWidth = 0; }
    if (wordWidth <= 510) { line = word.segment; lineWidth = wordWidth; continue; }
    for (const cluster of graphemes.segment(word.segment)) {
      const clusterWidth = width(doc, cluster.segment, size);
      if (line && lineWidth + clusterWidth > 510) { result.push(line); line = ''; lineWidth = 0; }
      line += cluster.segment; lineWidth += clusterWidth;
    }
  }
  result.push(line); return result;
}
/** One active render, at most eight queued requests. No unbounded promise backlog. */
let active = false;
const waiters: (() => void)[] = [];
async function acquire() {
  if (!active) { active = true; return; }
  if (waiters.length >= 8) throw new AppError('conflict', 'PDF renderer busy; retry shortly');
  await new Promise<void>(resolve => waiters.push(resolve));
}
function release() { const next = waiters.shift(); if (next) next(); else active = false; }
export type PdfBlock = { kind: 'text'; text: string; size?: number } | { kind: 'image'; bytes: Uint8Array; width: number; height: number } | { kind: 'pageBreak' };
export interface PdfInput {
  title: string; createdAt: Date; footer: string; blocks: readonly PdfBlock[];
}
/** Vendor-neutral diagnostics for the pinned font set; no fontkit objects escape. */
export function missingGlyphs(text: string): number[] {
  return [...new Set([...text].map(c => c.codePointAt(0)!))].filter(cp => ![9, 10, 12, 13].includes(cp) && !coverage.some((_entry, index) => covers(index, cp)));
}
export async function renderPdf(input: PdfInput): Promise<Uint8Array> {
  await acquire();
  try {
    if (input.blocks.length > 1000 || input.blocks.reduce((size, block) => size + (block.kind === 'text' ? block.text.length : 0), 0) > 100_000) throw new AppError('invalid_request', 'PDF is too large');
    const doc = new PDFDocument({ size: 'LETTER', margin: 48, font: pdfFont(font(0)) as unknown as string, autoFirstPage: false,
      info: { Title: input.title, CreationDate: input.createdAt, ModDate: input.createdAt } });
    const chunks: Buffer[] = []; let bytes = 0;
    const finished = new Promise<Uint8Array>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) doc.destroy(new AppError('invalid_request', 'PDF too large')); else chunks.push(chunk); });
      doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    });
    // Attach a handler before synchronous layout can fail.
    void finished.catch(() => undefined);
    let y = 48, pages = 0;
    function page() {
      if (++pages > 100) throw new AppError('invalid_request', 'PDF exceeds page limit');
      doc.addPage(); y = 48;
      drawLine(doc, replacements(input.footer), 744, 7);
    }
    function paragraph(value: string, size = 11) {
      for (const input of value.split('\n')) {
        const direction = (bidi.getEmbeddingLevels(input).paragraphs[0]?.level ?? 0) % 2 ? 'rtl' : 'ltr';
        for (const line of wrapLines(doc, replacements(input.replaceAll('\t', '    ').replaceAll('\r', '')), size)) {
          if (y > 698) page(); drawLine(doc, line, y, size, direction); y += size * 1.8;
        }
      }
      y += 8;
    }
    try {
      page();
      for (const block of input.blocks) {
        if (block.kind === 'text') paragraph(block.text, block.size ?? 11);
        else if (block.kind === 'pageBreak') page();
        else {
          if (y + block.height > 710) page();
          doc.image(Buffer.from(block.bytes), 48, y, { fit: [block.width, block.height] }); y += block.height + 8;
        }
      }
      doc.end(); return await finished;
    } catch (error) { doc.destroy(); throw error; }
  } finally { release(); }
}
