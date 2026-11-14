// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-control-regex -- PDF whitespace includes the NUL byte. */
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream, PDFRef, PDFInvalidObject, PDFContext, PDFObjectParser, type PDFObject } from '@cantoo/pdf-lib';
import { AppError } from '@plaingym/shared';
import { pdfText } from './messages.js';
import { scanPdfObject } from './document-syntax.js';

export const documentByteLimit = 10 * 1024 * 1024;
function invalid(message = pdfText('malformed')): never { throw new AppError('invalid_request', message); }
const activeMessage = pdfText('active');
const forbidden = new Set(['JavaScript', 'JS', 'AA', 'Launch', 'EmbeddedFiles', 'EmbeddedFile', 'Filespec',
  // A file specification's /Type is optional in practice, so its file entries are refused by name.
  'AF', 'EF', 'RF',
  'AcroForm', 'XFA', 'GoToR', 'GoToE', 'SubmitForm', 'ImportData', 'RichMedia', 'Movie', 'Sound', 'Rendition',
  'OCProperties', 'OC', 'OCG', 'OCMD', 'Encrypt', 'FFilter', 'FDecodeParms', 'OPI', 'PS',
  '3D', '3DD', '3DA', '3DView', '3DRef', 'RichMediaContent', 'RichMediaSettings',
  'Collection', 'AlternatePresentations', 'PresSteps', 'Alternates']);

/** `eol` counts the bytes before `endstream` that could be a line ending or the stream's own last data. */
interface EnvelopeObject { start: number; object: PDFObject; stream?: { start: number; size: number; eol: number } }
type Xrefs = Map<number, readonly [number, number, number]>;
interface XrefSection { dict: PDFDict; xrefs: Xrefs }
const revisionsMessage = pdfText('revisions');

/** A lexical envelope check supplements the repair-oriented vendor parser. It does not decode streams.
 * Static documents only: ambiguous revisions, duplicate objects and unaccounted bytes are refused. */
function envelope(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(text)) invalid(pdfText('notPdf'));
  if (!/%%EOF[\x00\t\n\f\r ]*$/.test(text)) invalid();
  let at = /^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.exec(text)![0].length;
  const budget = { nodes: 0 };
  const context = PDFContext.create();
  const objects = new Map<string, EnvelopeObject>();
  const sections = new Map<number, XrefSection>(), objectIds = new Set<number>();
  const tails: { target: number; start: number }[] = [];
  const skip = () => {
    for (;;) {
      while (/[\x00\t\n\f\r ]/.test(text[at] ?? '!')) at++;
      if (text[at] !== '%' || text.startsWith('%%EOF', at)) break;
      while (at < text.length && !/[\r\n]/.test(text[at]!)) at++;
    }
  };
  const match = (pattern: RegExp) => { const m = pattern.exec(text.slice(at)); if (!m) invalid(); at += m[0].length; return m; };
  const value = (): void => { at = scanPdfObject(text, at, budget); };
  skip();
  while (at < text.length) {
    if (text.startsWith('xref', at)) {
      const xref = at, xrefs: Xrefs = new Map(); at += 4; skip();
      while (/\d/.test(text[at] ?? '!')) {
        const section = match(/^(\d+)\s+(\d+)\s+/), first = Number(section[1]), count = Number(section[2]);
        if (!Number.isSafeInteger(first) || first < 0 || first + count > 100_000) invalid(pdfText('complex'));
        for (let i = 0; i < count; i++) {
          const row = match(/^(\d{10}) (\d{5}) ([nf])[ \r\n]+/);
          if (xrefs.has(first + i)) invalid();
          xrefs.set(first + i, [row[3] === 'n' ? 1 : 0, Number(row[1]), Number(row[2])]);
        }
        skip();
      }
      match(/^trailer\s*/);
      const start = at; value();
      const parsed = PDFObjectParser.forBytes(bytes.subarray(start, at), context).parseObject();
      if (!(parsed instanceof PDFDict)) invalid();
      sections.set(xref, { dict: parsed, xrefs });
      if (sections.size > 4) invalid(revisionsMessage);
      skip();
    } else if (text.startsWith('startxref', at)) {
      const start = at, tail = match(/^startxref\s+(\d+)\s+%%EOF[\x00\t\n\f\r ]*/);
      tails.push({ start, target: Number(tail[1]) });
      if (tails.length > 2) invalid(revisionsMessage);
      skip();
    } else {
      const start = at, header = match(/^(\d+)\s+(\d+)\s+obj\b\s*/);
      const key = `${Number(header[1])} ${Number(header[2])}`;
      if (objectIds.has(Number(header[1]))) invalid(revisionsMessage);
      if (Number(header[1]) < 1 || Number(header[1]) > 100_000 || Number(header[2]) > 65535) invalid();
      objectIds.add(Number(header[1]));
      const bodyStart = at; value(); const bodyEnd = at; skip();
      const object = PDFObjectParser.forBytes(bytes.subarray(bodyStart, bodyEnd), context).parseObject();
      context.assign(PDFRef.of(Number(header[1]), Number(header[2])), object);
      const entry: EnvelopeObject = { start, object };
      if (text.startsWith('stream', at)) {
        match(/^stream(?:\r\n|\n|\r)/);
        const streamStart = at;
        const end = /(?:\r\n|\n|\r)?endstream\s+endobj\b/g;
        end.lastIndex = at;
        const found = end.exec(text); if (!found) invalid();
        if (!(object instanceof PDFDict)) invalid();
        entry.stream = { start: streamStart, size: found.index - streamStart, eol: found[0].indexOf('endstream') };
        at = found.index + found[0].indexOf('endobj');
      }
      match(/^endobj\b/); objects.set(key, entry); skip();
    }
  }
  if (at !== text.length || !tails.length) invalid();
  return { objects, sections, tails };
}

/** PNG prediction on cross-reference bytes, bounded by the inflation budget before allocating. */
function unPredict(data: Buffer, dict: PDFDict, columns: number): Buffer {
  const params = dict.lookup(PDFName.of('DecodeParms'));
  if (!params) return data;
  if (!(params instanceof PDFDict)) invalid(pdfText('flate'));
  const number = (key: string, fallback: number) => params.has(PDFName.of(key)) ? params.lookup(PDFName.of(key), PDFNumber).asNumber() : fallback;
  const predictor = number('Predictor', 1);
  if (predictor === 1) return data;
  if (predictor < 10 || predictor > 15 || number('Colors', 1) !== 1 || number('BitsPerComponent', 8) !== 8 || number('Columns', 1) !== columns)
    invalid(pdfText('prediction'));
  if (columns < 1 || data.length % (columns + 1)) invalid();
  const output = Buffer.alloc(data.length / (columns + 1) * columns);
  let from = 0, to = 0;
  while (from < data.length) {
    const filter = data[from++]!;
    if (filter > 4) invalid();
    for (let col = 0; col < columns; col++, to++) {
      const left = col ? output[to - 1]! : 0, up = to >= columns ? output[to - columns]! : 0;
      const corner = col && to >= columns ? output[to - columns - 1]! : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      output[to] = (data[from++]! + predicted) & 255;
    }
  }
  return output;
}

/** Resolve the viewer's index; every physical object must appear in this same unambiguous view. */
function resolveSections(entries: Map<string, EnvelopeObject>, sections: Map<number, XrefSection>, tails: { target: number; start: number }[], length: number) {
  const last = tails.at(-1)!, primary = sections.get(last.target);
  if (!primary) invalid();
  const first = entries.values().next().value?.object;
  const linear = first instanceof PDFDict && first.has(PDFName.of('Linearized'));
  if (linear) {
    if (first.lookup(PDFName.of('Linearized'), PDFNumber).asNumber() !== 1 || first.lookup(PDFName.of('L'), PDFNumber).asNumber() !== length ||
      last.target !== Math.min(...sections.keys()) || sections.size !== 2 ||
      primary.dict.lookup(PDFName.of('Prev'), PDFNumber).asNumber() <= last.target || tails.length === 2 && tails[0]!.target !== 0) invalid(revisionsMessage);
  } else if (sections.size > 1) {
    // Word writes a base table and an empty compatibility trailer pointing to a
    // supplemental stream. All objects precede the first EOF: nothing was revised.
    if (!primary.dict.has(PDFName.of('XRefStm')) || tails.length === 2 &&
      (primary.dict.lookup(PDFName.of('Prev'), PDFNumber).asNumber() !== tails[0]!.target || [...entries.values()].some(e => e.start > tails[0]!.start))) invalid(revisionsMessage);
  } else if (tails.length !== 1) invalid(revisionsMessage);
  const xrefs: Xrefs = new Map(), visited = new Set<number>();
  let root: PDFRef | undefined;
  const walk = (offset: number) => {
    if (visited.has(offset) || visited.size > 4) invalid(revisionsMessage);
    visited.add(offset);
    const section = sections.get(offset); if (!section) invalid();
    const { dict } = section;
    if (dict.has(PDFName.of('Encrypt'))) invalid(pdfText('encrypted'));
    const catalog = dict.get(PDFName.of('Root'));
    if (catalog) {
      if (!(catalog instanceof PDFRef) || root && root !== catalog) invalid(revisionsMessage);
      root = catalog;
    }
    if (dict.has(PDFName.of('Prev'))) walk(dict.lookup(PDFName.of('Prev'), PDFNumber).asNumber());
    for (const [id, entry] of section.xrefs) {
      const old = xrefs.get(id);
      // Free placeholders in hybrid tables can name compressed objects. Two
      // different live definitions (or deletion of a live definition) cannot.
      if (old?.[0] && old.some((value, i) => value !== entry[i])) invalid(revisionsMessage);
      xrefs.set(id, entry);
    }
    if (dict.has(PDFName.of('XRefStm'))) walk(dict.lookup(PDFName.of('XRefStm'), PDFNumber).asNumber());
  };
  walk(last.target);
  if (visited.size !== sections.size || !root) invalid();
  return { xrefs, root };
}

/** Structural parsing and resource bounds are shared by uploads and immutable records.
 * Upload acceptance policy lives separately, so later policy changes cannot invalidate a signed record. */
async function load(bytes: Uint8Array) {
  if (bytes.length > documentByteLimit) invalid(pdfText('byteLimit'));
  const { objects: entries, sections, tails } = envelope(bytes);
  // Bound object-stream expansion before PDFDocument.load inflates it. A parser accepting a
  // compressed bomb cannot be protected by a Promise timeout on the same event loop.
  let expanded = 0, compressedCount = 0;
  const budget = { nodes: 0 }, compressedIds = new Map<number, readonly [number, number]>();
  for (const [entryKey, entry] of entries) {
    if (!entry.stream) continue;
    const dict = entry.object as PDFDict;
    // A stream's data can end in CR or LF, so a byte that looks like the line ending may belong to it: /Length decides.
    const length = dict.lookup(PDFName.of('Length'), PDFNumber).asNumber();
    if (!Number.isSafeInteger(length) || length < entry.stream.size || length > entry.stream.size + entry.stream.eol) invalid();
    entry.stream.size = length;
    // The vendor parser resolves /Type, so an indirect one must meet the same inflation budget.
    const type = dict.lookup(PDFName.of('Type'));
    if (type !== PDFName.of('ObjStm') && type !== PDFName.of('XRef')) continue;
    const filter = dict.lookup(PDFName.of('Filter'));
    if (filter && filter !== PDFName.of('FlateDecode') || type === PDFName.of('ObjStm') && dict.has(PDFName.of('DecodeParms')))
      invalid(pdfText('flate'));
    const begin = entry.stream.start;
    let decoded: Buffer;
    try {
      decoded = filter ? inflateSync(bytes.subarray(begin, begin + entry.stream.size), { maxOutputLength: 8 * 1024 * 1024 - expanded }) : Buffer.from(bytes.subarray(begin, begin + entry.stream.size));
      expanded += decoded.length;
      if (expanded > 8 * 1024 * 1024) invalid(pdfText('malformedComplex'));
    }
    catch { invalid(pdfText('malformedComplex')); }
    if (type === PDFName.of('ObjStm')) {
      const count = dict.lookup(PDFName.of('N'), PDFNumber).asNumber(), first = dict.lookup(PDFName.of('First'), PDFNumber).asNumber();
      compressedCount += count;
      if (!Number.isSafeInteger(count) || count < 1 || compressedCount > 10_000 || !Number.isSafeInteger(first) || first < 0 || first > decoded.length)
        invalid(pdfText('malformedComplex'));
      const text = decoded.toString('latin1'), header = text.slice(0, first).trim().split(/\s+/);
      if (header.length !== count * 2 || header.some(item => !/^\d+$/.test(item))) invalid();
      for (let i = 0; i < count; i++) {
        const id = Number(header[i * 2]), offset = Number(header[i * 2 + 1]), next = i + 1 === count ? decoded.length - first : Number(header[i * 2 + 3]);
        if (!Number.isSafeInteger(id) || id <= 0 || id > 100_000 || compressedIds.has(id) || entries.has(`${id} 0`) || offset < 0 || i === 0 && offset !== 0 || next <= offset || next > decoded.length - first)
          invalid();
        compressedIds.set(id, [Number(entryKey.split(' ')[0]), i]);
        const body = text.slice(first + offset, first + next), end = scanPdfObject(body, 0, budget);
        if (!/^[\x00\t\n\f\r ]*$/.test(body.slice(end))) invalid();
      }
    } else {
      const xrefs: Xrefs = new Map();
      sections.set(entry.start, { dict, xrefs });
      const widths = dict.lookup(PDFName.of('W'), PDFArray).asArray().map(item => {
        if (!(item instanceof PDFNumber)) invalid(); return item.asNumber();
      });
      const size = dict.lookup(PDFName.of('Size'), PDFNumber).asNumber();
      if (widths.length !== 3 || widths.some(w => !Number.isInteger(w) || w < 0 || w > 4) || !Number.isInteger(size) || size < 1 || size > 100_000) invalid();
      decoded = unPredict(decoded, dict, widths.reduce((sum, width) => sum + width, 0));
      const ranges = dict.has(PDFName.of('Index')) ? dict.lookup(PDFName.of('Index'), PDFArray).asArray().map(item => {
        if (!(item instanceof PDFNumber)) invalid(); return item.asNumber();
      }) : [0, size];
      if (ranges.length % 2 || ranges.length > 20_000 || ranges.some(n => !Number.isSafeInteger(n) || n < 0 || n > size)) invalid();
      let offset = 0, rows = 0;
      for (let i = 0; i < ranges.length; i += 2) {
        const start = ranges[i]!, count = ranges[i + 1]!;
        rows += count;
        if (start + count > size || rows > 100_000) invalid();
        for (let j = 0; j < count; j++) {
          const fields = widths.map((width, field) => {
            if (offset + width > decoded.length) invalid();
            let value = width === 0 && field === 0 ? 1 : 0;
            for (let k = 0; k < width; k++) value = value * 256 + decoded[offset++]!;
            return value;
          });
          if (xrefs.has(start + j) || ![0, 1, 2].includes(fields[0]!)) invalid();
          xrefs.set(start + j, [fields[0]!, fields[1]!, fields[2]!]);
        }
      }
      if (offset !== decoded.length) invalid();
    }
  }
  const { xrefs, root } = resolveSections(entries, sections, tails, bytes.length);
  for (const [key, entry] of entries) {
    const [id, generation] = key.split(' ').map(Number), indexed = xrefs.get(id!);
    if (!indexed || indexed[0] !== 1 || indexed[1] !== entry.start || indexed[2] !== generation) invalid();
  }
  for (const [id, [owner, index]] of compressedIds) {
    const indexed = xrefs.get(id);
    if (!indexed || indexed[0] !== 2 || indexed[1] !== owner || indexed[2] !== index) invalid();
  }
  for (const [id, [type, field, generation]] of xrefs) {
    if (type === 1 && entries.get(`${id} ${generation}`)?.start !== field || type === 2 && !compressedIds.has(id)) invalid();
  }
  let document: PDFDocument;
  try { document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, warnOnInvalidObjects: false, updateMetadata: false }); }
  catch { invalid(pdfText('unreadable')); }
  if (document.isEncrypted || document.context.trailerInfo.Encrypt) invalid(pdfText('encrypted'));
  for (const id of compressedIds.keys()) if (!document.context.lookup(PDFRef.of(id, 0))) invalid();
  if (!(root instanceof PDFRef) || document.context.lookup(root) !== document.catalog) invalid();
  const seen = new Set<PDFObject>(); let nodes = 0;
  const visit = (object: PDFObject, depth = 0): void => {
    if (depth > 40 || ++nodes > 100_000) invalid(pdfText('complex'));
    if (object instanceof PDFRef) {
      const target = document.context.lookup(object);
      if (!target) invalid();
      // The copying parser resolves one reference at a time. A chain could hide
      // an action subtype from it while a viewer follows the chain.
      if (target instanceof PDFRef) invalid(pdfText('chained'));
      return;
    }
    if (seen.has(object)) return; seen.add(object);
    if (object instanceof PDFInvalidObject) invalid();
    if (object instanceof PDFRawStream) {
      visit(object.dict, depth + 1);
    }
    else if (object instanceof PDFArray) object.asArray().forEach(item => visit(item, depth + 1));
    else if (object instanceof PDFDict) {
      for (const item of object.values()) {
        visit(item, depth + 1);
      }
    }
  };
  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    visit(object);
    if (object instanceof PDFRawStream) {
      const length = object.dict.lookup(PDFName.of('Length'), PDFNumber).asNumber();
      if (entries.get(`${ref.objectNumber} ${ref.generationNumber}`)?.stream?.size !== length) invalid();
    }
  }
  // A shared/cyclic Kids graph can make the library's recursive page enumeration
  // expand exponentially despite the ordinary object walk's visited set.
  const pageNodes = new Set<PDFObject>(); let pageCount = 0;
  const pagesName = PDFName.of('Pages'), pageName = PDFName.of('Page');
  const pageTree = (raw: PDFObject | undefined, depth = 0): number => {
    if (!raw || depth > 20) invalid(pdfText('pageTree'));
    const node = raw instanceof PDFRef ? document.context.lookup(raw) : raw;
    if (!(node instanceof PDFDict) || pageNodes.has(node)) invalid(pdfText('pageTree'));
    pageNodes.add(node);
    if (node.get(PDFName.of('Type')) === pageName) {
      if (++pageCount > 20) invalid(pdfText('pageCount'));
      return 1;
    }
    if (node.get(PDFName.of('Type')) !== pagesName) invalid(pdfText('pageTree'));
    const kids = node.lookup(PDFName.of('Kids'), PDFArray);
    if (kids.size() > 20) invalid(pdfText('pageCount'));
    let count = 0;
    for (const kid of kids.asArray()) count += pageTree(kid, depth + 1);
    if (node.lookup(PDFName.of('Count'), PDFNumber).asNumber() !== count) invalid(pdfText('pageTree'));
    return count;
  };
  const pages = pageTree(document.catalog.get(pagesName));
  if (pages < 1 || pages > 20) invalid(pdfText('pageCount'));
  if (document.getPageCount() !== pages) invalid(pdfText('pageTree'));
  return document;
}

function validateUploadPolicy(document: PDFDocument) {
  const name = PDFName.of;
  const pages = new Set<PDFDict>(document.getPages().map(page => page.node));
  const links = new Set<PDFObject>(), uriActions = new Set<PDFObject>(), actions = new Set<PDFObject>();
  const dicts: PDFDict[] = [];
  const seen = new Set<PDFObject>();
  const collect = (object: PDFObject): void => {
    if (seen.has(object)) return; seen.add(object);
    if (object instanceof PDFRawStream) {
      if (object.dict.has(name('F'))) invalid(activeMessage);
      collect(object.dict);
    } else if (object instanceof PDFArray) object.asArray().forEach(collect);
    else if (object instanceof PDFDict) { dicts.push(object); object.values().forEach(collect); }
  };
  for (const [, object] of document.context.enumerateIndirectObjects()) collect(object);
  for (const dict of dicts) {
    for (const key of ['A', 'OpenAction']) {
      const action = dict.lookup(name(key));
      // Tagged PDFs use /A for structure attributes, which have no /S; every action has one.
      // A claimed /Type can't exempt an /A, since viewers ignore it on outlines and annotations.
      if (action instanceof PDFDict && (key === 'OpenAction' || action.has(name('S')))) actions.add(action);
    }
    if (!dict.has(name('Annots'))) continue;
    const annots = dict.lookup(name('Annots'));
    if (!(annots instanceof PDFArray)) invalid(activeMessage);
    for (const raw of annots.asArray()) {
      const annot = raw instanceof PDFRef ? document.context.lookup(raw) : raw;
      if (!(annot instanceof PDFDict) || annot.lookup(name('Subtype')) !== name('Link') ||
        ['AP', 'AS', 'AA'].some(key => annot.has(name(key)))) invalid(activeMessage);
      const flags = annot.lookup(name('F'));
      if (flags && (!(flags instanceof PDFNumber) || (flags.asNumber() & (1 | 2 | 32)) !== 0)) invalid(activeMessage);
      links.add(annot);
      const action = annot.lookup(name('A'));
      if (action && !(action instanceof PDFDict)) invalid(activeMessage);
      if (action instanceof PDFDict) { uriActions.add(action); actions.add(action); }
    }
  }
  for (const dict of dicts) {
    if (dict.lookup(name('Type')) === name('Annot') && !links.has(dict) ||
      dict.has(name('Subtype')) && dict.lookup(name('Subtype')) === name('Link') && !links.has(dict)) invalid(activeMessage);
    if (dict.has(name('OpenAction'))) {
      const action = dict.lookup(name('OpenAction'));
      if (action instanceof PDFArray) {
        const destination = action.lookup(0);
        if (!(destination instanceof PDFDict) || !pages.has(destination)) invalid(activeMessage);
      } else if (!(action instanceof PDFDict) || action.lookup(name('S')) !== name('GoTo')) invalid(activeMessage);
    }
    const action = dict.lookup(name('S'));
    // /S is also used by ordinary graphics dictionaries (for example /S /Transparency).
    const isAction = dict.lookup(name('Type')) === name('Action') || actions.has(dict);
    if (isAction && (action !== name('GoTo') && action !== name('URI') || dict.has(name('Next')))) invalid(activeMessage);
    if (dict.has(name('URI')) || dict.lookup(name('S')) === name('URI')) {
      const uri = dict.lookup(name('URI'));
      if (!uriActions.has(dict) || dict.lookup(name('S')) !== name('URI') ||
        !(uri instanceof PDFString || uri instanceof PDFHexString) || !/^(https?:|mailto:)/i.test(uri.decodeText())) invalid(activeMessage);
    }
    for (const [key, item] of dict.entries()) {
      const value = item instanceof PDFRef ? document.context.lookup(item) : item;
      if (forbidden.has(key.decodeText()) || ['Type', 'Subtype', 'S'].includes(key.decodeText()) && value instanceof PDFName && forbidden.has(value.decodeText()) ||
        key === name('S') && value === name('Thread') ||
        key === name('Ref') && (dict.lookup(name('Type')) === name('XObject') || dict.lookup(name('Subtype')) === name('Form'))) invalid(activeMessage);
    }
  }
}

let active = false;
/** One active operation, eight waiting in total, and at most two waiting per gym. */
const queue: { gymId: string; run: () => void }[] = [];
async function bounded<T>(gymId: string, work: () => Promise<T>) {
  if (active) {
    if (queue.length >= 8 || queue.filter(entry => entry.gymId === gymId).length >= 2)
      // A full queue is momentary: the busy reason gets a one-second Retry-After and clients' retry text (core/errors.ts).
      throw new AppError('rate_limited', pdfText('busy'), { reason: ['busy'] });
    await new Promise<void>(resolve => queue.push({ gymId, run: resolve }));
  } else active = true;
  try { return await work(); }
  finally { const next = queue.shift(); if (next) next.run(); else active = false; }
}
type PdfBytes = Uint8Array | (() => Promise<Uint8Array>);
const readBytes = async (input: PdfBytes) => typeof input === 'function' ? input() : input;
export function validateDocumentPdf(input: PdfBytes, gymId: string): Promise<{ pages: number; bytes: number }> {
  return bounded(gymId, async () => {
    // A storage or integrity failure is not a malformed upload, so it stays outside the catch below.
    const bytes = await readBytes(input);
    try {
      const document = await load(bytes);
      validateUploadPolicy(document);
      return { pages: document.getPageCount(), bytes: bytes.length };
    }
    catch (error) { if (error instanceof AppError) throw error; invalid(); }
  });
}
/** Original page contents/resources are copied, never painted, stamped or reflowed.
 * The signing sets the metadata, as on a generated copy, so a later render doesn't restate its date. */
export async function appendSignaturePdf(original: PdfBytes, signature: PdfBytes, details: { title: string; createdAt: Date }, gymId: string): Promise<Uint8Array> {
  // The details page renders in its own queue before this one's slot is taken, so a full text queue never keeps every
  // gym's uploads and signed copies waiting; a busy details renderer is refused before the stored original is read.
  const signatureBytes = await readBytes(signature);
  return bounded(gymId, async () => {
    const signed = await PDFDocument.load(signatureBytes), document = await load(await readBytes(original));
    const result = await PDFDocument.create({ updateMetadata: false });
    for (const page of await result.copyPages(document, document.getPageIndices())) result.addPage(page);
    for (const page of await result.copyPages(signed, signed.getPageIndices())) result.addPage(page);
    result.setTitle(details.title);
    result.setCreationDate(details.createdAt);
    result.setModificationDate(details.createdAt);
    return result.save();
  });
}
