// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { AppError } from '@plaingym/shared';
import { importTargetFieldSchema, type ImportColumnMapping } from '@plaingym/shared/contracts';

export interface CsvRow { rowNumber: number; values: Record<string, string> }
export interface CsvDocument { columns: string[]; rows: CsvRow[] }
export const MAX_CSV_BYTES = 20 * 1024 * 1024;
const COMMA = 44, QUOTE = 34, LF = 10, CR = 13;
/** Strict RFC 4180 records, accepting LF and CRLF, quoted newlines and a UTF-8 BOM. */
export function parseCsv(text: string): CsvDocument {
  if (Buffer.byteLength(text) > MAX_CSV_BYTES || text.includes('\0')) invalid();
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Cells are slices of the text. Appending them one character at a time builds a rope of cons strings per cell,
  // which cost over 4 KB of heap per row for a 200-byte row.
  const records: { line: number; cells: string[] }[] = [], end = text.length;
  let cells: string[] = [], line = 1, start = 1, hasRecord = false, i = 0;
  for (;;) {
    let value: string;
    if (text.charCodeAt(i) === QUOTE) {
      hasRecord = true; value = '';
      for (let pos = i + 1; ;) {
        const quote = text.indexOf('"', pos);
        if (quote < 0) invalid();
        for (let j = pos; j < quote; j++) {
          const c = text.charCodeAt(j);
          if (c === LF || c === CR && text.charCodeAt(j + 1) !== LF) line++;
        }
        value += text.slice(pos, quote);
        if (text.charCodeAt(quote + 1) === QUOTE) { value += '"'; pos = quote + 2; } else { i = quote + 1; break; }
      }
      const next = text.charCodeAt(i);
      if (i < end && next !== COMMA && next !== LF && next !== CR) invalid();
    } else {
      let j = i;
      for (; j < end; j++) {
        const c = text.charCodeAt(j);
        if (c === COMMA || c === LF || c === CR) break;
        if (c === QUOTE) invalid();
      }
      if (j > i) hasRecord = true;
      value = text.slice(i, j); i = j;
    }
    cells.push(value);
    const terminator = text.charCodeAt(i);
    if (i < end && terminator === COMMA) { i++; hasRecord = true; continue; }
    if (hasRecord) records.push({ line: start, cells });
    if (i >= end) break;
    if (terminator === CR && text.charCodeAt(i + 1) === LF) i++;
    i++; cells = []; hasRecord = false; line++; start = line;
  }
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
