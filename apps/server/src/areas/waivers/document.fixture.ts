// SPDX-License-Identifier: AGPL-3.0-only
import { renderPdf } from '../../infra/pdf/index.js';

/** Synthetic legal-page layout used by the upload/signing regression tests. */
export function waiverDocumentFixture(pages = 2) {
  return renderPdf({ title: 'Uploaded participation document', createdAt: new Date('2026-11-05T12:00:00Z'),
    footer: 'Original document', blocks: Array.from({ length: pages }, (_, index) => [
      ...(index ? [{ kind: 'pageBreak' as const }] : []), { kind: 'text' as const, text: `Original waiver page ${index + 1}` },
    ]).flat() });
}
