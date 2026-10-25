// SPDX-License-Identifier: AGPL-3.0-only
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { digest, serializeSnapshot } from './snapshot.js';
export const scripts = ['山田太郎 王小明 김민수', 'Александр Иванов', 'أحمد محمد', 'أحمد محمد 12345 ١٢٣٤٥', 'Jose\u0301 A\u030Angstro\u0308m', 'مُحَمَّد أَحْمَد'];
export function pdfFixture(body = scripts.join('\n'), signerName = 'Alex Example') {
  const png = demoSignaturePng();
  return { png, ...serializeSnapshot({
    template: { id: '01900000-0000-7000-8000-000000000001', name: 'Participation', kind: 'waiver', version: 1, body },
    member: { id: '01900000-0000-7000-8000-000000000002', firstName: 'Alex', lastName: 'Example', dateOfBirth: '1990-01-01' },
    signer: { kind: 'self', name: signerName }, signedAt: '2026-10-24T12:00:00.000Z', signatureImage: { key: 'fixture.png', hash: digest(png) },
  }) };
}
