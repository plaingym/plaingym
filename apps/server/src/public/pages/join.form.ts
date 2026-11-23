// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type Translator } from '@plaingym/shared';
import { maxJoinDocuments, maxJoinMembers, publicContracts, type WaiverTemplate } from '@plaingym/shared/contracts';
import { joinPhone } from '@plaingym/shared/phone-countries';
import { validateSignatureImage } from '../../areas/waivers/snapshot.js';
import { joinFieldProblems } from './join.service.js';

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
  const generalProblems: string[] = [], contactProblems: string[] = [];
  const memberProblems = Array.from({ length: count }, () => ({ fields: [] as string[],
    documents: Array.from({ length: maxJoinDocuments }, () => [] as string[]) }));
  const add = (path: readonly PropertyKey[], message: string) => {
    const person = path[0] === 'members' ? memberProblems[Number(path[1])] : undefined;
    const target = person ? path[2] === 'signatures' ? person.documents[Number(path[3])] ?? person.fields : person.fields
      : path[0] === 'contact' ? contactProblems : generalProblems;
    target.push(message);
  };
  const phone = joinPhone(value('phoneCountry'), value('phone'));
  const contact = { name: value('contactName'), email: value('email'), ...(phone ? { phone } : {}) };
  const documents = Array.from({ length: maxJoinDocuments }, (_, j) => j).filter(j => value(`waiver-0-${j}-template`));
  const members = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const person = text('member', { number: i + 1 });
    const member = { firstName: value(`member-${i}-firstName`), lastName: value(`member-${i}-lastName`), dateOfBirth: value(`member-${i}-dateOfBirth`) };
    const signatures = await Promise.all(documents.map(async (j, documentIndex) => {
      const prefix = `waiver-${i}-${j}`, file = fields.get(prefix + '-image');
      const templateId = value(prefix + '-template'), templateVersion = Number(value(prefix + '-version'));
      const document = person + ': ' + (templates.find(tp => tp.id === templateId)?.name ?? text('signature'));
      const signer = value(prefix + '-kind') === 'guardian'
        ? { kind: 'guardian' as const, name: value(prefix + '-name'), relationship: value(prefix + '-relationship') }
        : { kind: 'self' as const, name: value(prefix + '-name') };
      // Keep each document's problems together even when file reads finish in another order.
      const documentPath = ['members', i, 'signatures', documentIndex];
      if (value(prefix + '-consent') !== 'on') add(documentPath, text('checkConsent', { document }));
      let pngBase64 = '';
      if (!(file instanceof File) || !file.size || file.size > 256 * 1024) add(documentPath, text('checkSignature', { document }));
      else {
        const bytes = Buffer.from(await file.arrayBuffer());
        try { validateSignatureImage(bytes); pngBase64 = bytes.toString('base64'); }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== 'invalid_request') throw error;
          add(documentPath, text('checkPng', { document }));
        }
      }
      return { templateId, templateVersion, pngBase64, signer };
    }));
    if (signatures.length !== templates.length || templates.some(tp => !signatures.some(s => s.templateId === tp.id && s.templateVersion === tp.version))) {
      add([], text('conflict'));
      for (const template of templates) if (!signatures.some(s => s.templateId === template.id))
        add(['members', i, 'signatures', templates.indexOf(template)], text('checkSignature', { document: person + ': ' + template.name }));
    }
    return { member, signatures };
  }));
  const labels: Record<string, string> = { name: text('signerName'), email: text('email'), phone: text('phone'), firstName: text('firstName'),
    lastName: text('lastName'), dateOfBirth: text('dateOfBirth'), relationship: text('relationship') };
  const fieldProblem = (path: readonly PropertyKey[]) => {
    const name = String(path.at(-1)), label = path[0] === 'contact' && name === 'name' ? text('contactName') : labels[name];
    return label ? text('checkField', { field: (path[0] === 'members' ? text('member', { number: Number(path[1]) + 1 }) + ': ' : '') + label }) : text('checkApplicants');
  };
  for (const problem of joinFieldProblems(contact, members, now, timezone)) {
    const person = text('member', { number: Number(problem.path[1]) + 1 });
    const signature = members[Number(problem.path[1])]?.signatures[Number(problem.path[3])];
    const document = person + ': ' + (templates.find(tp => tp.id === signature?.templateId)?.name ?? text('signature'));
    add(problem.path, problem.kind === 'birthDate' ? text('checkBirthDate', { member: person })
      : problem.kind === 'guardian' ? text('checkGuardian', { document }) : fieldProblem(problem.path));
  }
  const parsed = publicContracts.joinAdmission.body.safeParse({ planId: value('planId'), contact, members, honeypot: value('honeypot'),
    smsNoticesConsent: value('smsNoticesConsent') === 'on', smsAnnouncementsConsent: value('smsAnnouncementsConsent') === 'on',
    ...(value('code').trim() ? { code: value('code') } : {}) });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // File failures already have a document-specific problem above.
      if (issue.path.at(-1) === 'pngBase64') continue;
      add(issue.path, fieldProblem(issue.path));
    }
  }
  const problems = [...generalProblems, ...contactProblems, ...memberProblems.flatMap(p => [...p.fields, ...p.documents.flat()])];
  if (problems.length || !parsed.success) throw new JoinFormError([...new Set(problems)]);
  return parsed.data;
}

/** Service refusals retain their own meaning; never infer another cause by rechecking fields. */
export function joinRefusalProblems(error: unknown, t: Translator): readonly string[] {
  if (error instanceof JoinFormError) return error.problems;
  if (error instanceof AppError && error.details?.reason?.includes('sms_phone_required')) return [t('public/join:smsPhoneRequired')];
  const key = codeRefused(error) ? 'codeRefused' : error instanceof AppError && error.code === 'conflict' ? 'conflict' : 'checkApplicants';
  return [t('public/join:' + key)];
}
export const codeRefused = (error: unknown) => error instanceof AppError && error.details?.reason?.[0] === 'code_refused';
