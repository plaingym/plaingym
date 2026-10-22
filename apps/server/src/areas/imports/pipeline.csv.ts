// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { AppError } from '@plaingym/shared';
import { importTargetFieldSchema, type ImportColumnMapping } from '@plaingym/shared/contracts';

export interface CsvRow { rowNumber: number; values: Record<string, string> }
export interface CsvDocument { columns: string[]; rows: CsvRow[] }
export const MAX_CSV_BYTES = 20 * 1024 * 1024;
/** Strict RFC 4180 records, accepting LF and CRLF, quoted newlines and a UTF-8 BOM. */
export function parseCsv(text: string): CsvDocument {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES || text.includes('\0')) invalid();
  text = text.replace(/^\uFEFF/, '');
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = '', quoted = false, closed = false, line = 1, start = 1, hasRecord = false;
  const field = () => { cells.push(cell); cell = ''; closed = false; };
  const record = () => { field(); if (hasRecord) records.push({ line: start, cells }); cells = []; hasRecord = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== '\r' && c !== '\n') hasRecord = true;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += c; if (c === '\n' || c === '\r' && text[i + 1] !== '\n') line++; }
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record(); line++; start = line;
    } else if (c === '"') { if (cell !== '' || closed) invalid(); quoted = true; }
    else { if (closed) invalid(); cell += c; }
  }
  if (quoted) invalid();
  if (hasRecord) record();
  const columns = records.shift()?.cells.map((name) => name.trim()) ?? [];
  if (!columns.length || columns.length > 200 || columns.some((name) => !name || name.length > 256)
    || new Set(columns).size !== columns.length) invalid();
  if (records.length > 100_000) invalid();
  return { columns, rows: records.map(({ line, cells }) => {
    if (cells.length !== columns.length) invalid();
    return { rowNumber: line, values: Object.fromEntries(columns.map((name, i) => [name, cells[i]!])) };
  }) };
}
function invalid(): never { throw new AppError('invalid_request', t('imports/pipeline:invalidCsv')); }
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<string, string> = { givenname: 'firstName', surname: 'lastName', familyname: 'lastName', emailaddress: 'email',
  dob: 'dateOfBirth', birthdate: 'dateOfBirth', mobilenumber: 'phone', customerid: 'stripeCustomerId', memberid: 'externalId' };
export function autoMatch(columns: readonly string[]): ImportColumnMapping[] {
  const fields = new Map(importTargetFieldSchema.options.map((field) => [normalize(field), field]));
  const used = new Set<string>();
  return columns.flatMap((sourceColumn) => {
    const normalized = normalize(sourceColumn), targetField = fields.get(normalize(aliases[normalized] ?? normalized));
    if (!targetField || used.has(targetField)) return [];
    used.add(targetField); return [{ sourceColumn, targetField }];
  });
}
/** Strings are always quoted; neutralize spreadsheet formulas, including leading whitespace. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export const csvLine = (values: readonly unknown[]) => values.map(csvCell).join(',') + '\r\n';

/** Composite identities avoid delimiter collisions; empty identities never match. */
export function duplicateKey(values: readonly (string | null | undefined)[]): string | null {
  const normalized = values.map((value) => value?.normalize('NFKC').trim().toLowerCase() ?? '');
  return normalized.some(Boolean) ? JSON.stringify(normalized) : null;
}
export class DuplicateIndex {
  readonly #ids = new Map<string, Set<string>>();
  add(key: string | null, id: string): void {
    if (key === null) return;
    const ids = this.#ids.get(key) ?? new Set<string>(); ids.add(id); this.#ids.set(key, ids);
  }
  find(key: string | null): string[] { return key === null ? [] : [...(this.#ids.get(key) ?? [])]; }
}
