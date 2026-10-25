// SPDX-License-Identifier: AGPL-3.0-only
import { renderWaiver } from './pdf.js';
import { pdfFixture, scripts } from './pdf.fixture.js';
import { loadedFontFiles } from '../../infra/pdf/index.js';
const mode = process.argv[2] ?? 'mixed';
const names = mode === 'latin' ? 'Alex Example' : mode === 'cyrillic' ? 'Александр Иванов' : scripts.join('\n');
const f = pdfFixture(Array.from({ length: 20 }, (_, n) => `Section ${n + 1}\n${names}\n${'Training involves physical activity. '.repeat(25)}`).join('\n\f\n'));
let heap = 0;
for (let n = 0; n < 11; n++) {
  const pdf = await renderWaiver(f.snapshot, f.snapshotHash, f.png);
  heap = Math.max(heap, process.memoryUsage().heapUsed);
  if (n === 0 || n === 10) process.stdout.write(JSON.stringify({ run: n === 0 ? 'cold' : 'repeated', rssMiB: process.resourceUsage().maxRSS / 1024,
    heapMiB: heap / 1024 / 1024, pages: (Buffer.from(pdf).toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, fonts: loadedFontFiles() }) + '\n');
}
