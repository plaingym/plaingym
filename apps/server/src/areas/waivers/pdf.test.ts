// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderWaiver } from './pdf.js';
import { missingGlyphs } from '../../infra/pdf/index.js';
import { digest, needsGuardian, readSnapshot } from './snapshot.js';
import { pdfFixture, scripts } from './pdf.fixture.js';

describe('immutable waiver rendering', () => {
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
  it('requires guardians until the eighteenth local birthday, and for unknown birthdays', () => {
    const now = new Date('2026-10-24T01:00:00Z');
    expect(needsGuardian('2008-10-24', now, 'America/Vancouver')).toBe(true);
    expect(needsGuardian('2008-10-24', now, 'UTC')).toBe(false);
    expect(needsGuardian(null, now, 'UTC')).toBe(true);
  });
  it('bounds cold/repeated Latin and mixed source/bundle memory and loads only the required faces', () => {
    const options = { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' as const, timeout: 120_000, windowsHide: true };
    const build = spawnSync(process.execPath, ['src/areas/waivers/pdf-bundle.mjs'], options);
    expect(build.status, build.stderr + build.stdout).toBe(0);
    for (const bundle of [false, true]) for (const mode of ['latin', 'mixed', ...(bundle ? [] : ['cyrillic'])]) {
      const run = spawnSync(process.execPath, ['--max-old-space-size=256', ...(bundle
        ? ['../../coverage/waivers/pdf-bundle/server.mjs'] : ['--import', 'tsx', 'src/areas/waivers/pdf-benchmark.ts']), mode], options);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const records = run.stdout.trim().split('\n').map(line => JSON.parse(line) as { run: string; rssMiB: number; heapMiB: number; pages: number; fonts: string[] });
      expect(records.map(r => r.run)).toEqual(['cold', 'repeated']);
      for (const record of records) {
        expect(record.pages).toBe(20); if (bundle) expect(record.rssMiB).toBeLessThan(300); expect(record.heapMiB).toBeLessThan(256);
        expect(record.fonts).toEqual(mode === 'mixed' ? ['NotoSans-Regular.ttf', 'NotoSansCJKsc-Regular.ttf', 'NotoSansArabic-Regular.ttf'] : ['NotoSans-Regular.ttf']);
      }
      console.info('Waiver memory:', bundle ? 'bundle' : 'source', mode, records);
    }
  }, 180_000);
});
