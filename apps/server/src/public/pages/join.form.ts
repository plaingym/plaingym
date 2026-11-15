// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type Translator } from '@plaingym/shared';
import { dateSchema, maxJoinDocuments, maxJoinMembers, publicContracts, type WaiverTemplate } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { needsGuardian, validateSignatureImage } from '../../areas/waivers/snapshot.js';

/** Problems from the submitted fields, kept intact for the native form's refusal page. */
export class JoinFormError extends Error {
  constructor(readonly problems: readonly string[]) { super('Invalid join form'); }
}

/** Decode and validate once; redisplay uses these problems rather than checking the form again. */
export async function readJoinForm(fields: FormData, templates: readonly WaiverTemplate[], t: Translator, now: Date, timezone: string) {
  const value = (name: string) => { const field = fields.get(name); return typeof field === 'string' ? field : ''; };
  const text = (key: string, args?: Record<string, string | number>) => t('public/join:' + key, args);
  const count = Number(value('members'));
  if (!Number.isInteger(count) || count < 1 || count > maxJoinMembers) throw new JoinFormError([text('checkApplicants')]);
  const problems: string[] = [];
  const bounded = (name: string, label: string, max: number) => {
    if (value(name).trim().length > max) problems.push(text('checkField', { field: label }));
  };
  bounded('contactName', text('contactName'), 200);
  bounded('email', text('email'), 254);
  bounded('phone', text('phone'), 100);
  const contact = { name: value('contactName'), email: value('email'), ...(value('phone') ? { phone: value('phone') } : {}) };
  const documents = Array.from({ length: maxJoinDocuments }, (_, j) => j).filter(j => value(`waiver-0-${j}-template`));
  const members = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const person = text('member', { number: i + 1 });
    const member = { firstName: value(`member-${i}-firstName`), lastName: value(`member-${i}-lastName`), dateOfBirth: value(`member-${i}-dateOfBirth`) };
    bounded(`member-${i}-firstName`, person + ': ' + text('firstName'), 200);
    bounded(`member-${i}-lastName`, person + ': ' + text('lastName'), 200);
    // A missing or malformed date gets only its field problem; the age checks need a real date.
    const dated = dateSchema.safeParse(member.dateOfBirth).success;
    if (dated && member.dateOfBirth > localDate(now, timezone)) problems.push(text('checkBirthDate', { member: person }));
    const signatures = await Promise.all(documents.map(async j => {
      const prefix = `waiver-${i}-${j}`, file = fields.get(prefix + '-image');
      const templateId = value(prefix + '-template'), templateVersion = Number(value(prefix + '-version'));
      const document = person + ': ' + (templates.find(tp => tp.id === templateId)?.name ?? text('signature'));
      const signer = value(prefix + '-kind') === 'guardian'
        ? { kind: 'guardian' as const, name: value(prefix + '-name'), relationship: value(prefix + '-relationship') }
        : { kind: 'self' as const, name: value(prefix + '-name') };
      bounded(prefix + '-name', person + ': ' + text('signerName'), 200);
      if (signer.kind === 'guardian') bounded(prefix + '-relationship', person + ': ' + text('relationship'), 100);
      if (dated && needsGuardian(member.dateOfBirth, now, timezone) && signer.kind !== 'guardian') problems.push(text('checkGuardian', { document }));
      if (value(prefix + '-consent') !== 'on') problems.push(text('checkConsent', { document }));
      let pngBase64 = '';
      if (!(file instanceof File) || !file.size || file.size > 256 * 1024) problems.push(text('checkSignature', { document }));
      else {
        const bytes = Buffer.from(await file.arrayBuffer());
        try { validateSignatureImage(bytes); pngBase64 = bytes.toString('base64'); }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== 'invalid_request') throw error;
          problems.push(text('checkPng', { document }));
        }
      }
      return { templateId, templateVersion, pngBase64, signer };
    }));
    if (signatures.length !== templates.length || templates.some(tp => !signatures.some(s => s.templateId === tp.id && s.templateVersion === tp.version))) {
      problems.unshift(text('conflict'));
      for (const template of templates) if (!signatures.some(s => s.templateId === template.id))
        problems.push(text('checkSignature', { document: person + ': ' + template.name }));
    }
    return { member, signatures };
  }));
  const parsed = publicContracts.joinAdmission.body.safeParse({ planId: value('planId'), contact, members, honeypot: value('honeypot'),
    ...(value('code').trim() ? { code: value('code') } : {}) });
  if (!parsed.success) {
    const labels: Record<string, string> = { name: text('signerName'), email: text('email'), phone: text('phone'), firstName: text('firstName'),
      lastName: text('lastName'), dateOfBirth: text('dateOfBirth'), relationship: text('relationship') };
    for (const issue of parsed.error.issues) {
      // File failures already have a document-specific problem above.
      if (issue.path.at(-1) === 'pngBase64') continue;
      const name = String(issue.path.at(-1));
      const label = issue.path[0] === 'contact' && name === 'name' ? text('contactName') : labels[name];
      problems.push(label ? text('checkField', { field: (issue.path[0] === 'members' ? text('member', { number: Number(issue.path[1]) + 1 }) + ': ' : '') + label }) : text('checkApplicants'));
    }
  }
  if (problems.length || !parsed.success) throw new JoinFormError([...new Set(problems)]);
  return parsed.data;
}

/** Service refusals retain their own meaning; never infer another cause by rechecking fields. */
export function joinRefusalProblems(error: unknown, t: Translator): readonly string[] {
  if (error instanceof JoinFormError) return error.problems;
  const reason = error instanceof AppError ? error.details?.reason?.[0] : undefined;
  const key = reason === 'code_refused' ? 'codeRefused' : error instanceof AppError && error.code === 'conflict' ? 'conflict' : 'checkApplicants';
  return [t('public/join:' + key)];
}
