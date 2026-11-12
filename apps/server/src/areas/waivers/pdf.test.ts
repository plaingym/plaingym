// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { validateDocumentPdf } from '../../infra/pdf/document.js';
import { renderWaiver } from './pdf.js';
import { missingGlyphs } from '../../infra/pdf/index.js';
import { digest, needsGuardian, readSnapshot, serializeSnapshot } from './snapshot.js';
import { pdfFixture, scripts } from './pdf.fixture.js';

describe('immutable waiver rendering', () => {
  it('renders a hash-matching stored document despite current upload policy, and refuses changed bytes', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([{ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 100, 100] }]));
    const bytes = await doc.save(), f = pdfFixture('');
    const snapshot = readSnapshot(f.snapshot, f.snapshotHash);
    const stored = serializeSnapshot({ ...snapshot, template: { ...snapshot.template, document: {
      key: '01900000-0000-7000-8000-000000000003/waivers/templates/01900000-0000-7000-8000-000000000004.pdf',
      hash: digest(bytes), bytes: bytes.length, pages: 1,
    } } });
    await expect(validateDocumentPdf(bytes)).rejects.toThrow(/active content/);
    const rendered = await renderWaiver(stored.snapshot, stored.snapshotHash, f.png, async () => bytes, 'gym-stored');
    expect((await PDFDocument.load(rendered)).getPageCount()).toBe(2);
    const changed = Uint8Array.from(bytes); changed[10] = changed[10]! ^ 1;
    await expect(renderWaiver(stored.snapshot, stored.snapshotHash, f.png, changed)).rejects.toThrow('Waiver document integrity failure');
  });
  for (const script of scripts) it('independently extracts and embeds ' + script, async () => {
    const f = pdfFixture(script, script), bytes = await renderWaiver(f.snapshot, f.snapshotHash, f.png);
    const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
    const pdf = await task.promise;
    try {
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1), content = await page.getTextContent();
      const lines = content.items.flatMap(item => 'str' in item ? [item.str] : []);
      const extracted = lines.join(' ').normalize('NFC').replace(/\s+/g, ' ');
      expect(extracted).toContain(script.normalize('NFC'));
      expect(extracted.split(script.normalize('NFC')).length).toBe(3); // Body and labelled signer.
      expect(extracted).toContain(digest(f.snapshot));
      const ops = await page.getOperatorList();
      expect(ops.fnArray).toContain(OPS.paintImageXObject);
      const fontNames = new Set(content.items.flatMap(item => 'fontName' in item ? [item.fontName] : []));
      for (const name of fontNames) {
        const font = page.commonObjs.get(name) as { missingFile?: boolean; data?: Uint8Array; name: string };
        expect(font.missingFile).not.toBe(true);
        expect(font.data?.length).toBeGreaterThan(100);
        expect(font.data!.length).toBeLessThan(250_000); // Embedded subsets, never a full CJK face.
      }
      expect(missingGlyphs(script)).toEqual([]);
      expect(Buffer.from(bytes).toString('latin1')).toMatch(/\/FontFile[23]/);
    } finally { await task.destroy(); }
  });
  it('rejects corrupted snapshot or image bytes without poisoning the queue', async () => {
    const f = pdfFixture();
    expect(() => readSnapshot(f.snapshot + ' ', f.snapshotHash)).toThrow('integrity');
    await expect(renderWaiver(f.snapshot, f.snapshotHash, Uint8Array.from(f.png, (x, i) => i === 40 ? x ^ 1 : x))).rejects.toThrow();
    await expect(renderWaiver(f.snapshot, f.snapshotHash, f.png)).resolves.toBeInstanceOf(Uint8Array);
  });
  it('replaces each missing code point in a Hebrew signer name and keeps the rest of the line', async () => {
    const f = pdfFixture('Original accepted terms', 'Before שלום After');
    const bytes = await renderWaiver(f.snapshot, f.snapshotHash, f.png);
    const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      const extracted = content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ');
      expect(extracted).toContain('Before ���� After');
      expect(extracted).toContain('Original accepted terms');
      expect(extracted).toContain(f.snapshotHash);
    } finally { await task.destroy(); }
  });
  it('uses the original snapshot whitespace and key order for every page footer', async () => {
    const f = pdfFixture('First page\n\f\nSecond page');
    const parsed = JSON.parse(f.snapshot), raw = JSON.stringify({ signedAt: parsed.signedAt, ...parsed }, null, 2) + '\n';
    const hash = digest(raw); expect(hash).not.toBe(f.snapshotHash);
    const bytes = await renderWaiver(raw, hash, f.png), task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
    try {
      const pdf = await task.promise; expect(pdf.numPages).toBe(2);
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        expect(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')).toContain(hash);
      }
    } finally { await task.destroy(); }
  });
  it('bounds concurrency and queue length, then releases all slots', async () => {
    const f = pdfFixture('Hello'), calls = Array.from({ length: 12 }, () => renderWaiver(f.snapshot, f.snapshotHash, f.png));
    const results = await Promise.allSettled(calls);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(9);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(3);
    await expect(renderWaiver(f.snapshot, f.snapshotHash, f.png)).resolves.toBeInstanceOf(Uint8Array);
  });
  it('refuses a full text-render queue before reading a stored PDF', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    const bytes = await doc.save(), f = pdfFixture('Hello');
    const snapshot = readSnapshot(f.snapshot, f.snapshotHash);
    const stored = serializeSnapshot({ ...snapshot, template: { ...snapshot.template, body: '', document: {
      key: '01900000-0000-7000-8000-000000000003/waivers/templates/01900000-0000-7000-8000-000000000004.pdf',
      hash: digest(bytes), bytes: bytes.length, pages: 1,
    } } });
    const running = Promise.allSettled(Array.from({ length: 9 }, () => renderWaiver(f.snapshot, f.snapshotHash, f.png)));
    let reads = 0;
    try {
      await expect(renderWaiver(stored.snapshot, stored.snapshotHash, f.png, async () => { reads++; return bytes; }, 'busy-details'))
        .rejects.toMatchObject({ code: 'rate_limited' });
      expect(reads).toBe(0);
    } finally { await running; }
  });
  it('requires guardians until the eighteenth local birthday, and for unknown birthdays', () => {
    const now = new Date('2026-10-24T01:00:00Z');
    expect(needsGuardian('2008-10-24', now, 'America/Vancouver')).toBe(true);
    expect(needsGuardian('2008-10-24', now, 'UTC')).toBe(false);
    expect(needsGuardian(null, now, 'UTC')).toBe(true);
  });
  it("passes the image's V8 flags to every node command its start scripts run", () => {
    const dir = new URL('../../../../../deploy/container/', import.meta.url);
    const scripts = readdirSync(dir).filter(name => name.endsWith('.sh'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) for (const line of readFileSync(new URL(name, dir), 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      expect(/(?:^\s*|; |exec )node (?!\$\{PLAINGYM_NODE_FLAGS)/.test(line), `${name}: ${line.trim()}`).toBe(false);
    }
  });
  it('bounds cold/repeated Latin and mixed source/bundle memory and loads only the required faces', () => {
    // Run the bundle as the runtime image runs every app process: the allocator defaults and V8 flags come from deploy/Dockerfile.
    // Without the semi-space flag a major garbage collection in the ten repeats adds about 80 MiB to the peak on some runs.
    const dockerfile = readFileSync(new URL('../../../../../deploy/Dockerfile', import.meta.url), 'utf8');
    const image = (name: string) => { const line = new RegExp(`^ENV (?:.* )?${name}=(\\S+)`, 'm').exec(dockerfile); expect(line, `${name} in deploy/Dockerfile`).not.toBeNull(); return line![1]!; };
    const nodeFlags = image('PLAINGYM_NODE_FLAGS').split(' ');
    const env = { ...process.env, MALLOC_MMAP_THRESHOLD_: image('MALLOC_MMAP_THRESHOLD_'), MALLOC_ARENA_MAX: image('MALLOC_ARENA_MAX') };
    const options = { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' as const, timeout: 120_000, windowsHide: true, env };
    const build = spawnSync(process.execPath, ['src/areas/waivers/pdf-bundle.mjs'], options);
    expect(build.status, build.stderr + build.stdout).toBe(0);
    for (const bundle of [false, true]) for (const mode of ['latin', 'mixed', ...(bundle ? [] : ['cyrillic'])]) {
      const run = spawnSync(process.execPath, ['--max-old-space-size=256', ...nodeFlags, ...(bundle
        ? ['../../coverage/waivers/pdf-bundle/server.mjs'] : ['--import', 'tsx', 'src/areas/waivers/pdf-benchmark.ts']), mode], options);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const records = run.stdout.trim().split('\n').map(line => JSON.parse(line) as { run: string; rssMiB: number; heapMiB: number; pages: number; fonts: string[] });
      expect(records.map(r => r.run)).toEqual(['cold', 'repeated']);
      for (const record of records) {
        expect(record.pages).toBe(20); if (bundle) expect(record.rssMiB, `${mode} ${record.run}: ${JSON.stringify(record)}`).toBeLessThan(300); expect(record.heapMiB).toBeLessThan(256);
        expect(record.fonts).toEqual(mode === 'mixed' ? ['NotoSans-Regular.ttf', 'NotoSansCJKsc-Regular.ttf', 'NotoSansArabic-Regular.ttf'] : ['NotoSans-Regular.ttf']);
      }
      console.info('Waiver memory:', bundle ? 'bundle' : 'source', mode, records);
    }
  }, 180_000);
});
