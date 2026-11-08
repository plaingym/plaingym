// SPDX-License-Identifier: AGPL-3.0-only
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import PDFKit from 'pdfkit';
import { PDFDocument, PDFName, PDFDict } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { appendSignaturePdf, documentByteLimit, validateDocumentPdf } from './document.js';
import { waiverPdf } from '../../../../../deploy/test/memory/waiver-pdf.mjs';
import { hybridPdf, linearizedPdf, predictedXrefPdf } from './document-structures.fixture.js';

const signedCopy = { title: 'Waiver', createdAt: new Date('2026-11-01T12:00:00Z') };
async function fixture(pages = 2, options: PDFKit.PDFDocumentOptions = {}) {
  const document = new PDFKit({ autoFirstPage: false, ...options }), chunks: Buffer[] = [];
  document.on('data', chunk => chunks.push(chunk as Buffer));
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on('end', () => resolve(Buffer.concat(chunks))); document.on('error', reject);
  });
  for (let i = 0; i < pages; i++) { document.addPage(); document.text(`Original page ${i + 1}`); }
  document.end(); return finished;
}
async function modified(key: string) {
  const pdf = await PDFDocument.load(await fixture());
  pdf.catalog.set(PDFName.of(key), pdf.context.obj({}));
  return pdf.save();
}
/** A one-page PDF with exact offsets, for structures the writers above never produce. Streams are `[dictionary, data]`. */
function handBuilt(...extra: (string | readonly [string, Buffer])[]) {
  const objects: (string | readonly [string, Buffer])[] = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', ...extra];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')], offsets: number[] = [];
  let at = parts[0]!.length;
  const push = (part: Buffer) => { parts.push(part); at += part.length; };
  objects.forEach((object, i) => {
    offsets.push(at);
    if (typeof object === 'string') push(Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`));
    else {
      push(Buffer.from(`${i + 1} 0 obj\n<< ${object[0]} /Length ${object[1].length} >>\nstream\n`));
      push(object[1]); push(Buffer.from('\nendstream\nendobj\n'));
    }
  });
  const rows = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}
describe('untrusted PDF validation', () => {
  it.each([['Word hybrid', hybridPdf], ['linearized', linearizedPdf], ...[0, 1, 2, 3, 4].map(filter => [`predicted xref ${filter}`, () => predictedXrefPdf(filter)] as const)] as const)('accepts %s and preserves the text a separate reader sees', async (_name, make) => {
    const bytes = make();
    expect(await validateDocumentPdf(bytes)).toEqual({ pages: 1, bytes: bytes.length });
    for (const input of [bytes, await appendSignaturePdf(bytes, await fixture(1), signedCopy)]) {
      const task = getDocument({ data: Uint8Array.from(input), useSystemFonts: true });
      try {
        const pdf = await task.promise;
        const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
        expect(text).toBe('Original structured waiver');
      } finally { await task.destroy(); }
    }
  });
  it('rejects broken supplemental pointers, revision overlays and unindexed objects', async () => {
    const hybrid = hybridPdf().toString('latin1'), linear = linearizedPdf().toString('latin1');
    for (const text of [hybrid.replace(/\/XRefStm \d+/, '/XRefStm 0'), hybrid.replace(/\/Prev \d+/, '/Prev 1'),
      hybrid.replace('xref\n0 0', '9 0 obj\nnull\nendobj\nxref\n0 0'),
      hybrid.replace('xref\n0 0', '1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 0'),
      linear.replace(/\/L \d+/, '/L 0000000001'), hybrid.replace('/Root 1 0 R /Prev', '/Root 2 0 R /Prev'),
      linear.replace(/startxref\n\d+\n%%EOF\n$/, 'startxref\n1\n%%EOF\n')])
      await expect(validateDocumentPdf(Buffer.from(text, 'latin1'))).rejects.toThrow();
  });
  it('accepts a long bookmark chain with style flags and a font resource named F', async () => {
    const pdf = await PDFDocument.load(await fixture());
    let next: ReturnType<typeof pdf.context.register> | undefined;
    for (let i = 0; i < 100; i++) next = pdf.context.register(pdf.context.obj({ Title: `Bookmark ${i}`, F: 2, ...(next ? { Next: next } : {}) }));
    pdf.catalog.set(PDFName.of('Outlines'), pdf.context.obj({ First: next }));
    expect(await validateDocumentPdf(await pdf.save())).toMatchObject({ pages: 2 });
    expect(await validateDocumentPdf(hybridPdf())).toMatchObject({ pages: 1 });
  });
  it('still rejects external stream data and reference XObjects', async () => {
    await expect(validateDocumentPdf(handBuilt(['/F (external.pdf)', Buffer.from('x')]))).rejects.toThrow(/external references/);
    await expect(validateDocumentPdf(handBuilt('<< /Type /XObject /Subtype /Form /Ref << /F (external.pdf) >> >>'))).rejects.toThrow(/external references/);
    await expect(validateDocumentPdf(handBuilt('<< /S 5 0 R /F (external.pdf) /D (page) >>', '/GoToR'))).rejects.toThrow(/external references/);
    await expect(validateDocumentPdf(handBuilt('<< /S 5 0 R /F (external.pdf) /D (page) >>', '6 0 R', '/GoToR'))).rejects.toThrow(/chained object references/);
  });
  it('takes /Length as the stream end when the data itself ends in CR before the line ending', async () => {
    expect(await validateDocumentPdf(handBuilt(['', Buffer.from('q Q\r')]))).toMatchObject({ pages: 1 });
    await expect(validateDocumentPdf(Buffer.from(handBuilt(['', Buffer.from('q Q\r')]).toString('latin1').replace('/Length 4', '/Length 6'), 'latin1'))).rejects.toThrow(/malformed/);
  });
  it('applies the inflation budget to an object stream whose /Type is an indirect reference', async () => {
    const bomb = deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x20));
    await expect(validateDocumentPdf(handBuilt('/ObjStm', ['/Type 4 0 R /Filter /FlateDecode /N 1 /First 8', bomb]))).rejects.toThrow(/too complex/);
  });
  it('validates and merges the deployment fixture at both upload caps, retaining its page resources', async () => {
    const bytes = waiverPdf();
    expect(await validateDocumentPdf(bytes)).toEqual({ pages: 20, bytes: documentByteLimit });
    const merged = await appendSignaturePdf(bytes, await fixture(1), signedCopy);
    expect(merged.length).toBeGreaterThan(documentByteLimit * 0.99);
    const task = getDocument({ data: Uint8Array.from(merged), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      expect(pdf.numPages).toBe(21);
      for (const n of [1, 20, 21]) {
        const text = (await (await pdf.getPage(n)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
        expect(text).toContain(n === 21 ? 'Original page 1' : `Original waiver page ${n}`);
      }
    } finally { await task.destroy(); }
  });
  it('accepts a multi-page PDF', async () => {
    const bytes = await fixture(); expect(await validateDocumentPdf(bytes)).toEqual({ pages: 2, bytes: bytes.length });
  });
  it('accepts bounded compressed object streams', async () => {
    const doc = await PDFDocument.load(await fixture());
    expect(await validateDocumentPdf(await doc.save())).toMatchObject({ pages: 2 });
  });
  it('bounds compressed syntax and inflation before constructing vendor objects', async () => {
    for (const body of ['['.repeat(41) + '0' + ']'.repeat(41), ' '.repeat(8 * 1024 * 1024) + '0']) {
      const pdf = await PDFDocument.load(await fixture());
      // The writer drops existing ObjStm objects while rebuilding its own, so give
      // this stream its hostile type only after serialization (same byte length).
      pdf.context.register(pdf.context.flateStream(Buffer.from('99999 0 ' + body), { Type: 'Unsafe', N: 1, First: 8 }));
      const serialized = Buffer.from(await pdf.save()).toString('latin1');
      expect(serialized.includes('/Type /Unsafe')).toBe(true);
      await expect(validateDocumentPdf(Buffer.from(serialized.replace('/Type /Unsafe', '/Type /ObjStm'), 'latin1'))).rejects.toThrow(/too complex/);
    }
  });
  it('rejects an incorrect cross-reference offset instead of accepting parser recovery', async () => {
    const bytes = await fixture();
    const damaged = Buffer.from(bytes.toString('latin1').replace(/\d{10} 00000 n/, '0000000001 00000 n'), 'latin1');
    await expect(validateDocumentPdf(damaged)).rejects.toThrow(/malformed/);
  });
  it('rejects a non-PDF, truncated file, broken objects and a PDF-looking polyglot', async () => {
    const pdf = await fixture();
    for (const bytes of [Buffer.from('not a pdf'), pdf.subarray(0, -20),
      Buffer.from(pdf.toString('latin1').replace('endobj', 'xxxxxx'), 'latin1'),
      Buffer.concat([pdf, Buffer.from('<script>alert(1)</script>')]),
      Buffer.concat([Buffer.from('%PDF-1.3\n<script>alert(1)</script>\n'), pdf.subarray(pdf.indexOf('\n') + 1)])])
      await expect(validateDocumentPdf(bytes)).rejects.toThrow();
  });
  it('rejects a real password-protected PDF', async () => {
    await expect(validateDocumentPdf(await fixture(1, { userPassword: 'test-password', ownerPassword: 'owner-password' }))).rejects.toThrow();
  });
  it('rejects a missing trailer root even when the vendor parser repairs it', async () => {
    const pdf = await fixture();
    const damaged = Buffer.from(pdf.toString('latin1').replace(/\/Root \d+ 0 R/, '/Root 99999 0 R'), 'latin1');
    await expect(validateDocumentPdf(damaged)).rejects.toThrow(/malformed/);
  });
  it.each(['OpenAction', 'AA', 'JavaScript', 'EmbeddedFiles', 'AcroForm', 'XFA', 'URI', 'OCProperties', 'Launch'])('rejects %s', async key => {
    await expect(validateDocumentPdf(await modified(key))).rejects.toThrow(/active content/);
  });
  it('rejects an embedded file', async () => {
    const doc = await PDFDocument.load(await fixture());
    await doc.attach(Buffer.from('private attachment'), 'attachment.txt');
    await expect(validateDocumentPdf(await doc.save())).rejects.toThrow(/active content/);
  });
  it.each([['associated', 'AF'], ['embedded', 'EF'], ['related', 'RF']])('rejects %s file entries without a file specification type', async (_name, key) => {
    await expect(validateDocumentPdf(await modified(key))).rejects.toThrow(/active content/);
  });
  it('rejects a thread action naming another file, and keeps ordinary article threads', async () => {
    await expect(validateDocumentPdf(handBuilt('<< /Title (Next) /A << /S /Thread /F (external.pdf) /D 0 >> >>'))).rejects.toThrow(/external references/);
    expect(await validateDocumentPdf(handBuilt('<< /Type /Thread /I << /Title (Article) >> >>'))).toMatchObject({ pages: 1 });
  });
  it('requires annotations and alternate appearances to be flattened', async () => {
    for (const subtype of ['Text', '3D', 'RichMedia']) {
      const doc = await PDFDocument.load(await fixture());
      const annotation = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [0, 0, 100, 100] }));
      doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annotation]));
      await expect(validateDocumentPdf(await doc.save())).rejects.toThrow(/active content/);
    }
    await expect(validateDocumentPdf(await modified('Alternates'))).rejects.toThrow(/active content/);
  });
  it('rejects size and page caps', async () => {
    await expect(validateDocumentPdf(Buffer.alloc(documentByteLimit + 1))).rejects.toThrow(/10 MiB/);
    await expect(validateDocumentPdf(await fixture(21))).rejects.toThrow(/20 pages/);
  });
  it.each(['cycle', 'repeated', 'count'])('rejects a %s page tree before recursive page enumeration', async kind => {
    const pdf = await PDFDocument.load(await fixture());
    const root = pdf.catalog.get(PDFName.of('Pages'))!;
    const tree = pdf.context.lookup(root, PDFDict);
    if (kind === 'cycle') tree.set(PDFName.of('Kids'), pdf.context.obj([root]));
    else if (kind === 'repeated') {
      const page = pdf.getPage(0).ref;
      tree.set(PDFName.of('Kids'), pdf.context.obj([page, page]));
    } else tree.set(PDFName.of('Count'), pdf.context.obj(1));
    await expect(validateDocumentPdf(await pdf.save({ addDefaultPage: false }))).rejects.toThrow(/page tree/);
  });
  it('dates a signed copy from the signing, so every render of it is identical', async () => {
    const details = { title: 'Liability waiver', createdAt: new Date('2026-11-01T12:00:00Z') };
    const [original, signature] = [await fixture(), await fixture(1)];
    const first = await appendSignaturePdf(original, signature, details), later = await appendSignaturePdf(original, signature, details);
    expect(Buffer.compare(first, later)).toBe(0);
    const copy = await PDFDocument.load(first, { updateMetadata: false });
    expect(copy.getTitle()).toBe('Liability waiver');
    expect(copy.getCreationDate()).toEqual(details.createdAt);
    expect(copy.getModificationDate()).toEqual(details.createdAt);
    expect(copy.getProducer()).toBeUndefined();
  });
  it('copies the original pages before the appended details', async () => {
    const bytes = await appendSignaturePdf(await fixture(), await fixture(1), signedCopy);
    const reader = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
    try {
      const document = await reader.promise; expect(document.numPages).toBe(3);
      const text = await Promise.all([1, 2, 3].map(async page => (await (await document.getPage(page)).getTextContent()).items
        .map(item => 'str' in item ? item.str : '').join(' ')));
      expect(text).toEqual(['Original page 1', 'Original page 2', 'Original page 1']);
    } finally { await reader.destroy(); }
  });
});
