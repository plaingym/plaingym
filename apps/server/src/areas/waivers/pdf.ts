// SPDX-License-Identifier: AGPL-3.0-only
import { waiverValidation } from './messages.js';
import { AppError, createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { renderPdf, missingGlyphs, type PdfBlock } from '../../infra/pdf/index.js';
import { digest, readSnapshot, validateSignatureImage } from './snapshot.js';
import { appendSignaturePdf } from '../../infra/pdf/document.js';
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
  if (missing.length) throw new AppError('invalid_request', waiverValidation('unsupportedCharacters', { characters: missing.slice(0, 30)
    .map(cp => `${String.fromCodePoint(cp)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`).join(', ') + (missing.length > 30 ? ' …' : '') }));
  const blocks = templateBlocks({ ...template, version: 1 });
  // Reserve two pages for signing details. Signing preflights their layout outside its transaction.
  blocks.push({ kind: 'pageBreak' }, { kind: 'text', text: 'Signature details' }, { kind: 'pageBreak' });
  await renderPdf({ title: template.name, createdAt: new Date(0), footer: 'SHA-256 ' + '0'.repeat(64), blocks });
}

const documentIntegrity = (bytes: Uint8Array | undefined, document: { hash: string; bytes: number }) => {
  if (!bytes || digest(bytes) !== document.hash || bytes.length !== document.bytes) throw new Error('Waiver document integrity failure');
  return bytes;
};
/** The checked snapshot and its signing details page. Only the persisted text determines the footer. */
function signingDetails(snapshotText: string, snapshotHash: string, png: Uint8Array) {
  if (snapshotText.length > 600_000) throw new AppError('invalid_request', waiverValidation('waiverSize'));
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
  const metadata = { title: snapshot.template.name, createdAt: new Date(snapshot.signedAt) };
  const details = () => renderPdf({ ...metadata, footer: 'SHA-256 ' + digest(snapshotText), blocks });
  return { snapshot, metadata, details };
}

/** The signed copy: the template's original pages, when it has a document, then the signing details. */
export async function renderWaiver(snapshotText: string, snapshotHash: string, png: Uint8Array, document: Uint8Array | (() => Promise<Uint8Array>) | undefined, gymId: string): Promise<Uint8Array> {
  const { snapshot, metadata, details } = signingDetails(snapshotText, snapshotHash, png), stored = snapshot.template.document;
  if (!stored) return details();
  const original = async () => documentIntegrity(typeof document === 'function' ? await document() : document, stored);
  return appendSignaturePdf(original, details, metadata, gymId);
}

/**
 * Signing's check before it saves a snapshot: publication validated the immutable PDF bytes, so this checks that they
 * are unchanged and renders only the details page. `verify` checks the stored bytes without holding them whole.
 */
export async function preflightWaiver(snapshotText: string, snapshotHash: string, png: Uint8Array, verify: Uint8Array | (() => Promise<void>) | undefined): Promise<Uint8Array> {
  const { snapshot, details } = signingDetails(snapshotText, snapshotHash, png), stored = snapshot.template.document;
  if (stored) {
    if (typeof verify === 'function') await verify();
    else documentIntegrity(verify, stored);
  }
  return details();
}
