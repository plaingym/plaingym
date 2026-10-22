// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { autoMatch, csvLine, duplicateKey, DuplicateIndex, parseCsv } from './pipeline.csv.js';
describe('CSV import and duplicate utilities', () => {
  it('reads BOMs, CRLF, escaped quotes, commas, multiline fields and source line numbers', () => {
    expect(parseCsv('\uFEFFName,Note\r\n"Jo, Doe","Says ""hello""\nagain"\r\nSam,ok\r\n')).toEqual({
      columns: ['Name', 'Note'], rows: [
        { rowNumber: 2, values: { Name: 'Jo, Doe', Note: 'Says "hello"\nagain' } },
        { rowNumber: 4, values: { Name: 'Sam', Note: 'ok' } },
      ],
    });
  });
  it.each(['', 'name,name\nx,y', 'name,\nx,y', 'name\n"unclosed', 'name\n"closed"tail', 'name\nqu"ote', 'a,b\nx', 'a\nx,y', 'a\nx\0'])('rejects malformed CSV %j', (csv) => {
    expect(() => parseCsv(csv)).toThrow();
  });
  it('preserves zero-like cells, empty cells and prototype property names', () => {
    const document = parseCsv('__proto__,constructor,n\nplain,,0\n');
    expect(Object.hasOwn(document.rows[0]!.values, '__proto__')).toBe(true);
    expect(document.rows[0]!.values.n).toBe('0');
    expect(parseCsv('a,b\n,\n').rows).toHaveLength(1);
    expect(parseCsv('a\n""\n').rows).toHaveLength(1);
  });
  it('matches aliases and normalized headers without suggesting a field twice', () => {
    expect(autoMatch(['First Name', 'surname', 'Email Address', 'EMAIL', 'DOB', 'unrecognized'])).toEqual([
      { sourceColumn: 'First Name', targetField: 'firstName' }, { sourceColumn: 'surname', targetField: 'lastName' },
      { sourceColumn: 'Email Address', targetField: 'email' }, { sourceColumn: 'DOB', targetField: 'dateOfBirth' },
    ]);
  });
  it('encodes typed values and prevents spreadsheet formulas, including whitespace prefixes', () => {
    expect(csvLine(['a,"b', 'line\nnext', '=SUM(A1)', ' \t@foo', '-2+3', -100, null, true, { n: 1 }]))
      .toBe('"a,""b","line\nnext","\'=SUM(A1)","\' \t@foo","\'-2+3","-100","","true","{""n"":1}"\r\n');
  });
  it('matches normalized composite identities without matching empty identities or ambiguous delimiters', () => {
    const index = new DuplicateIndex();
    index.add(duplicateKey([' Person@Example.Test ']), 'a'); index.add(duplicateKey(['person@example.test']), 'b');
    expect(index.find(duplicateKey(['PERSON@example.test']))).toEqual(['a', 'b']);
    index.add(duplicateKey(['', null]), 'empty'); expect(index.find(null)).toEqual([]);
    expect(duplicateKey(['a|b', 'c'])).not.toEqual(duplicateKey(['a', 'b|c']));
  });
});
