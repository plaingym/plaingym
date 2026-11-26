// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardContracts, portalContracts, portalSignedLinkContracts, shellBootstrapResponseSchema } from '@plaingym/shared/contracts';
import { parseResponse } from './response.js';

const source = join(import.meta.dirname, '..');
/** A strict parse of fetched JSON: an open tab or kiosk would refuse a field a newer server adds. */
const directParse = /\.parse\(\s*await\s+(?:\w+(?:\.clone\(\))?\.json\(\)|request\(|createCopy\(|transport\()|\.then\(\s*\(?\s*(?<answer>\w+)\s*\)?\s*=>\s*(?!JSON\.|Date\.)[\w.]+\.parse\(\s*\k<answer>\s*\)/;
function appSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' || entry.name === 'tests' ? [] : appSources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name) || entry.name === 'browser-fixture.tsx') return [];
    return [path];
  });
}

const id = '00000000-0000-7000-8000-000000000001';
describe('client answer parsing', () => {
  it('strips additive keys at the envelope and nested discriminated-union levels without mutating the answer', () => {
    const answer = { householdId: id, release: 'new', data: { role: 'payer', memberId: null, extra: true } };
    expect(parseResponse(portalContracts.context.response, answer)).toEqual({ householdId: id, data: { role: 'payer', memberId: null } });
    expect(answer).toHaveProperty('release');
    expect(answer.data).toHaveProperty('extra');
    expect(portalContracts.context.response.safeParse(answer).success).toBe(false);
  });
  it('accepts new fields in array records while preserving required fields and validation', () => {
    const answer = { data: [{ id, type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2029, isDefault: true, added: 'field' }], householdId: id };
    expect(parseResponse(portalContracts.paymentMethods.response, answer).data[0]).not.toHaveProperty('added');
    expect(() => parseResponse(portalContracts.paymentMethods.response, { ...answer, householdId: undefined })).toThrow();
    expect(() => parseResponse(portalContracts.paymentMethods.response, { ...answer, data: [{ ...answer.data[0], last4: 'wrong' }] })).toThrow();
  });
  it('keeps cross-field refinements and required response fields', () => {
    expect(() => parseResponse(portalSignedLinkContracts.payInvoice.response, { data: { extra: true } })).toThrow();
    expect(() => parseResponse(shellBootstrapResponseSchema, { data: {}, added: true })).toThrow();
  });
  it('strips nested union keys and still rejects duplicate widgets after stripping', () => {
    const widget = { id: 'active_members', titleKey: 'members', status: 'ready', count: 3, added: true };
    const data = { generatedAt: '2026-11-05T12:00:00Z', widgets: [widget], added: true };
    expect(parseResponse(dashboardContracts.mat.response, { data }).data.widgets[0]).not.toHaveProperty('added');
    expect(() => parseResponse(dashboardContracts.mat.response, { data: { ...data, widgets: [widget, widget] } })).toThrow();
  });
  it('keeps direct strict parses of fetched JSON out of the app sources', () => {
    expect(directParse.test('return schema.parse(await response.json());')).toBe(true);
    expect(directParse.test('demoCreationResponse.parse(await createCopy(path, target, signal))')).toBe(true);
    expect(directParse.test('return schema.parse(await result.clone().json());')).toBe(true);
    expect(directParse.test('request(path, body).then(value => demoHandoffResponse.parse(value))')).toBe(true);
    expect(directParse.test('return parseResponse(schema, await response.json());')).toBe(false);
    expect(directParse.test('request(path, body).then(value => parseResponse(demoHandoffResponse, value))')).toBe(false);
    expect(directParse.test('file.text().then(text => JSON.parse(text))')).toBe(false);
    const files = appSources(source);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter(file => directParse.test(readFileSync(file, 'utf8'))).map(file => relative(source, file).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
