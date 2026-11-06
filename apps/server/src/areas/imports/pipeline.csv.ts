// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './pipeline.messages.js';
import { AppError } from '@plaingym/shared';
import { importTargetFieldSchema, type ImportColumnMapping } from '@plaingym/shared/contracts';

export interface CsvRow { rowNumber: number; values: Record<string, string> }
export interface CsvDocument { columns: string[]; rows: CsvRow[] }
interface CsvSource { text: string; spans: Uint32Array; columns: ReadonlyMap<string, number> }
const ESCAPED = 0x80000000;
function cell(source: Pick<CsvSource, 'text' | 'spans'>, offset: number): string {
  const end = source.spans[offset + 1]!;
  const value = source.text.slice(source.spans[offset]!, end & ~ESCAPED);
  return end & ESCAPED ? value.replaceAll('""', '"') : value;
}
/** Rows share the text and packed cell offsets; strings are sliced only for the chunk being mapped. */
class CompactRow implements CsvRow {
  readonly #source: CsvSource;
  readonly #offset: number;
  constructor(readonly rowNumber: number, offset: number, source: CsvSource) { this.#offset = offset; this.#source = source; }
  read(column: string): string {
    const index = this.#source.columns.get(column);
    return index === undefined ? '' : cell(this.#source, this.#offset + index * 2);
  }
  get values(): Record<string, string> { return Object.fromEntries([...this.#source.columns.keys()].map(name => [name, this.read(name)])); }
}
/** Mappers read cells directly, without allocating a values object per source row. */
export function csvValue(row: CsvRow, column: string): string {
  return row instanceof CompactRow ? row.read(column) : row.values[column] ?? '';
}
export const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_CSV_ROWS = 100_000, MAX_CSV_COLUMNS = 200;
const COMMA = 44, QUOTE = 34, LF = 10, CR = 13;
/**
 * Count separators outside quotes before allocating offsets, and refuse a file past the
 * limits before it costs an allocation. Blank lines need no storage.
 */
function cellCapacity(text: string): number {
  let cells = 1, columns = 1, rows = 0, quoted = false, record = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) { quoted = !quoted; record = true; }
    else if (!quoted && c === COMMA) {
      cells++; record = true;
      if (++columns > MAX_CSV_COLUMNS) invalid();
    } else if (!quoted && (c === LF || c === CR)) {
      if (record) {
        cells++;
        if (++rows > MAX_CSV_ROWS + 1) invalid();
      }
      columns = 1; record = false;
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
    } else record = true;
  }
  return cells;
}
/** Strict RFC 4180 records, accepting LF and CRLF, quoted newlines and a UTF-8 BOM. */
export function parseCsv(text: string): CsvDocument {
  if (Buffer.byteLength(text) > MAX_CSV_BYTES || text.includes('\0')) invalid();
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const records: { line: number; offset: number; count: number }[] = [], end = text.length;
  // One allocation: growing and copying typed arrays also consumes the container's memory.
  const boundaries = new Uint32Array(cellCapacity(text) * 2);
  let used = 0;
  let offset = 0, count = 0, line = 1, start = 1, hasRecord = false, i = 0;
  for (;;) {
    let from = i, to: number, escaped = false;
    if (text.charCodeAt(i) === QUOTE) {
      hasRecord = true; from = i + 1;
      for (let pos = i + 1; ;) {
        const quote = text.indexOf('"', pos);
        if (quote < 0) invalid();
        for (let j = pos; j < quote; j++) {
          const c = text.charCodeAt(j);
          if (c === LF || c === CR && text.charCodeAt(j + 1) !== LF) line++;
        }
        if (text.charCodeAt(quote + 1) === QUOTE) { escaped = true; pos = quote + 2; }
        else { to = quote; i = quote + 1; break; }
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
      to = j; i = j;
    }
    // Limits apply here, not after the parse: a small file of very short rows would otherwise fill the heap first.
    if (++count > MAX_CSV_COLUMNS) invalid();
    // A typed array drops a write past its end, which would import wrong cells without an error.
    if (used + 2 > boundaries.length) throw new Error('CSV offsets exceeded their counted capacity');
    boundaries[used++] = from; boundaries[used++] = escaped ? to | ESCAPED : to;
    const terminator = text.charCodeAt(i);
    if (i < end && terminator === COMMA) { i++; hasRecord = true; continue; }
    if (hasRecord) {
      if (records.push({ line: start, offset, count }) > MAX_CSV_ROWS + 1) invalid();
    } else {
      // Blank lines are ignored; discard their offsets too so they cannot fill the buffer.
      used = offset;
    }
    if (i >= end) break;
    if (terminator === CR && text.charCodeAt(i + 1) === LF) i++;
    i++; offset = used; count = 0; hasRecord = false; line++; start = line;
  }
  const spans = boundaries.subarray(0, used), header = records.shift();
  const columns = header ? Array.from({ length: header.count }, (_, i) => cell({ text, spans }, header.offset + i * 2).trim()) : [];
  if (!columns.length || columns.some((name) => !name || name.length > 256)
    || new Set(columns).size !== columns.length) invalid();
  const source: CsvSource = { text, spans, columns: new Map(columns.map((name, index) => [name, index])) };
  return { columns, rows: records.map(({ line, offset, count }) => {
    if (count !== columns.length) invalid();
    return new CompactRow(line, offset, source);
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
