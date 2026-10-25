// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { renderPdf, missingGlyphs, type PdfBlock } from '../../infra/pdf/index.js';
import { digest, readSnapshot, validateSignatureImage } from './snapshot.js';
const t = createTranslator(locales.en ?? {});
function templateBlocks(template: { name: string; version: number; body: string }): PdfBlock[] {
  const blocks: PdfBlock[] = [{ kind: 'text', text: template.name, size: 16 },
    { kind: 'text', text: `${t('waivers/waivers:version')} ${template.version}` }];
  for (const [index, text] of template.body.split('\f').entries()) {
    if (index) blocks.push({ kind: 'pageBreak' });
    blocks.push({ kind: 'text', text: text.replace(/^\n|\n$/g, '') });
  }
  return blocks;
}
/** Publication is rare: exercise the actual bounded layout before saving terms. */
export async function validateTemplatePdf(template: { name: string; body: string }) {
  const missing = missingGlyphs(template.name + template.body);
  if (missing.length) throw new AppError('invalid_request', 'Unsupported template characters: ' + missing.slice(0, 30)
    .map(cp => `${String.fromCodePoint(cp)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`).join(', ') + (missing.length > 30 ? ' …' : ''));
  const blocks = templateBlocks({ ...template, version: 1 });
  // Reserve two pages for signing details. Signing also preflights the complete
  // snapshot outside its transaction, including unusually long member names.
  blocks.push({ kind: 'pageBreak' }, { kind: 'text', text: 'Signature details' }, { kind: 'pageBreak' });
  await renderPdf({ title: template.name, createdAt: new Date(0), footer: 'SHA-256 ' + '0'.repeat(64), blocks });
}

/** Waiver-specific content and layout. Only the persisted text determines the footer. */
export async function renderWaiver(snapshotText: string, snapshotHash: string, png: Uint8Array): Promise<Uint8Array> {
  if (snapshotText.length > 600_000) throw new AppError('invalid_request', 'Waiver is too large');
  const snapshot = readSnapshot(snapshotText, snapshotHash);
  validateSignatureImage(png);
  if (digest(png) !== snapshot.signatureImage.hash) throw new Error('Waiver image integrity failure');
  const blocks = templateBlocks(snapshot.template);
  blocks.push({ kind: 'text', text: `${t('waivers/waivers:member')}: ${snapshot.member.firstName} ${snapshot.member.lastName}` },
    { kind: 'text', text: `${t('waivers/waivers:signer')}: ${snapshot.signer.name}` });
  if (snapshot.signer.kind === 'guardian') blocks.push({ kind: 'text', text: `${t('waivers/waivers:guardianSignature')}: ${snapshot.signer.relationship}` });
  blocks.push({ kind: 'text', text: `${t('waivers/waivers:signedAt')}: ${snapshot.signedAt}` });
  if (snapshot.commitmentEndsOn) blocks.push({ kind: 'text', text: `${t('waivers/waivers:commitment')}: ${snapshot.commitmentEndsOn}` });
  blocks.push({ kind: 'image', bytes: png, width: 240, height: 70 });
  return renderPdf({ title: snapshot.template.name, createdAt: new Date(snapshot.signedAt), footer: 'SHA-256 ' + digest(snapshotText), blocks });
}
