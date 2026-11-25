// SPDX-License-Identifier: AGPL-3.0-only
import { getCountries, getCountryCallingCode, getExampleNumber, Metadata, type CountryCode } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/mobile/examples';
import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
import { callingCode, internationalPrefixList, joinPhone, keepsInternationalPrefix, phoneCountries, phoneCountryOptions, splitPhone } from './phone-countries.js';

const exceptions = new Map<string, string>([
  ['CN', '2,100 carrier forms that start with 1, as every mobile number does'],
]);

/** Expands a phone-library IDDPrefix pattern into every string it matches. */
function expandIdd(pattern: string): string[] {
  let pos = 0;
  function parseAlt(): string[] {
    const results: string[] = [];
    while (true) {
      results.push(...parseSeq());
      if (pattern[pos] !== '|') break;
      pos += 1;
    }
    return results;
  }
  function parseSeq(): string[] {
    let prefixes = [''];
    while (pos < pattern.length && pattern[pos] !== '|' && pattern[pos] !== ')') {
      const choices = parseAtom();
      prefixes = prefixes.flatMap(prefix => choices.map(choice => prefix + choice));
    }
    return prefixes;
  }
  function parseAtom(): string[] {
    let items: string[];
    if (pattern[pos] === '(') {
      pos += 1;
      if (pattern.slice(pos, pos + 2) === '?:') pos += 2;
      items = parseAlt();
      if (pattern[pos] !== ')') throw new Error(`Expected ')' at ${pos} in ${pattern}`);
      pos += 1;
    } else if (pattern[pos] === '[') {
      pos += 1;
      items = [];
      while (pos < pattern.length && pattern[pos] !== ']') {
        const start = pattern[pos]!;
        if (pattern[pos + 1] === '-' && pattern[pos + 2] && pattern[pos + 2] !== ']') {
          const end = pattern[pos + 2]!;
          for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code += 1) {
            items.push(String.fromCharCode(code));
          }
          pos += 3;
        } else {
          items.push(start);
          pos += 1;
        }
      }
      if (pattern[pos] !== ']') throw new Error(`Expected ']' at ${pos} in ${pattern}`);
      pos += 1;
    } else if (pattern.slice(pos, pos + 2) === '\\d') {
      pos += 2;
      items = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    } else {
      items = [pattern[pos]!];
      pos += 1;
    }
    if (pattern[pos] === '?') {
      pos += 1;
      return ['', ...items];
    }
    return items;
  }
  const expanded = parseAlt();
  if (pos !== pattern.length) throw new Error(`Unexpected '${pattern[pos]}' at ${pos} in ${pattern}`);
  return [...new Set(expanded)];
}

describe('phone countries', () => {
  it('lists every region the phone library knows, in its order, with its calling code', () => {
    expect(phoneCountries).toEqual(getCountries().map(region => [region, getCountryCallingCode(region)]));
  });

  it('finds a calling code for a known region in any case and nothing otherwise', () => {
    expect(callingCode('CA')).toBe('1');
    expect(callingCode('gb')).toBe('44');
    expect(callingCode('ZZ')).toBeNull();
    expect(callingCode('')).toBeNull();
    expect(callingCode(null)).toBeNull();
    expect(callingCode(undefined)).toBeNull();
  });

  it('joins the chosen country code to a typed number unless the number starts with +', () => {
    expect(joinPhone('CA', '604 555 0123')).toBe('+1 604 555 0123');
    expect(joinPhone('ca', '604 555 0123')).toBe('+1 604 555 0123');
    expect(joinPhone('GB', '020 7946 0018')).toBe('+44 020 7946 0018');
    expect(normalizePhone('+44 020 7946 0018', null)).toBe('+442079460018');
    expect(joinPhone('CA', ' +44 20 7946 0018 ')).toBe('+44 20 7946 0018');
    expect(joinPhone('', '604 555 0123')).toBe('604 555 0123');
    expect(joinPhone(null, '604 555 0123')).toBe('604 555 0123');
    expect(joinPhone('ZZ', '604 555 0123')).toBe('604 555 0123');
    expect(joinPhone('CA', '   ')).toBe('');
    expect(joinPhone('CA', null)).toBe('');
  });

  it('replaces a chosen country\'s international prefix with +, or keeps it when the prefix carries a carrier code', () => {
    expect(internationalPrefixList('1')).toEqual(['011']);
    expect(internationalPrefixList('81')).toEqual(['010']);
    expect(internationalPrefixList('7')).toEqual(['810']);
    expect(internationalPrefixList('44')).toEqual(['00']);
    expect(internationalPrefixList('61')).toEqual([
      '0011', '0014', '0015', '0016', '0018', '0019',
      '14110011', '14140011', '14340011', '14410011', '14470011', '14560011', '14660011', '14740011', '14770011', '14880011',
    ]);
    expect(internationalPrefixList('680')).toEqual(['011', '012']);
    expect(internationalPrefixList('65')).toEqual(Array.from({ length: 40 }, (_, i) => '0' + String(i).padStart(2, '0')));
    expect(internationalPrefixList('886')).toEqual(['002', '005', '006', '007', '009', '019']);
    expect(keepsInternationalPrefix('55')).toBe(true);
    expect(keepsInternationalPrefix('44')).toBe(false);

    expect(joinPhone('GB', '0044 7700 900123')).toBe('+44 7700 900123');
    for (const [region, typed, expected] of [
      ['GB', '0044 20 7946 0018', '+44 20 7946 0018'],
      ['US', '011 44 20 7946 0018', '+44 20 7946 0018'],
      ['US', '(011) 44-20.7946 0018', '+44-20.7946 0018'],
      ['US', '011 +44 20 7946 0018', '+44 20 7946 0018'],
      ['GB', '00 (44) 20 7946 0018', '+44 20 7946 0018'],
      ['GB', '00 (+44) 20 7946 0018', '+44 20 7946 0018'],
      ['GB', '00 ( +44) 20 7946 0018', '+44 20 7946 0018'],
      ['AU', '0014 44 20 7946 0018', '+44 20 7946 0018'],
      ['AU', '0011 44 20 7946 0018', '+44 20 7946 0018'],
      ['AU', '14110011 44 20 7946 0018', '+44 20 7946 0018'],
      ['PW', '012 44 20 7946 0018', '+44 20 7946 0018'],
      ['IL', '014 44 20 7946 0018', '+44 20 7946 0018'],
      ['MX', '09 44 20 7946 0018', '+44 20 7946 0018'],
      ['FI', '99511 44 20 7946 0018', '+44 20 7946 0018'],
      ['AX', '990 44 20 7946 0018', '+44 20 7946 0018'],
      ['UY', '0174 44 20 7946 0018', '+44 20 7946 0018'],
      ['NZ', '0161 44 20 7946 0018', '+44 20 7946 0018'],
      ['SC', '010 44 20 7946 0018', '+44 20 7946 0018'],
      ['SC', '01 44 20 7946 0018', '+44 20 7946 0018'],
      ['MU', '033 44 20 7946 0018', '+44 20 7946 0018'],
      ['PE', '191100 44 20 7946 0018', '+44 20 7946 0018'],
      ['CL', '1200 44 20 7946 0018', '+44 20 7946 0018'],
    ] as const) {
      const joined = joinPhone(region, typed);
      expect(joined).toBe(expected);
      expect(normalizePhone(joined, 'US')).toBe('+442079460018');
      expect(normalizePhone(joined, null)).toBe('+442079460018');
    }

    expect(joinPhone('JP', '010 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('RU', '810 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('RU', '8 10 44 20 7946 0018')).toBe('+44 20 7946 0018');

    expect(joinPhone('JP', '03 1234 5678')).toBe('+81 03 1234 5678');
    expect(joinPhone('GB', '07700 900123')).toBe('+44 07700 900123');
    expect(joinPhone('US', '0044 20 7946 0018')).toBe('+1 0044 20 7946 0018');
    expect(joinPhone('GB', '00')).toBe('00');
    expect(joinPhone('BR', '0021 44 20 7946 0018')).toBe('0021 44 20 7946 0018');
    expect(joinPhone('SG', '019 44 20 7946 0018')).toBe('019 44 20 7946 0018');
    expect(joinPhone('TW', '019 44 20 7946 0018')).toBe('019 44 20 7946 0018');
    expect(joinPhone('SG', '6123 4567')).toBe('+65 6123 4567');
    expect(joinPhone('GB', '00 (44 20 7946 0018')).toBe('00 (44 20 7946 0018');
    expect(joinPhone('GB', '00 44) 20 7946 0018')).toBe('00 44) 20 7946 0018');
    expect(joinPhone('CV', '0 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('CV', '00 44 20 7946 0018')).toBe('00 44 20 7946 0018');
    expect(joinPhone('CN', '17951 00 44 20 7946 0018')).toBe('+86 17951 00 44 20 7946 0018');
    expect(joinPhone('MX', '55 1234 5678')).toBe('+52 55 1234 5678');
  });

  it('matches the phone library international prefix metadata for every region and carrier code', () => {
    const metadata = new Metadata();
    const carrierFallbackRegions = new Set(['BR', 'CO', 'ID', 'KH', 'KR', 'TH', 'TZ', 'UG']);
    for (const [region, code] of phoneCountries) {
      metadata.selectNumberingPlan(region as CountryCode);
      const pattern = metadata.numberingPlan?.IDDPrefix();
      expect(pattern, region).toBeTruthy();
      const prefixes = internationalPrefixList(code);
      if (exceptions.has(region)) continue;
      if (keepsInternationalPrefix(code) && prefixes.length === 1 && prefixes[0] === '00' && carrierFallbackRegions.has(region)) {
        expect(pattern!.startsWith('00'), region).toBe(true);
        continue;
      }
      const exact = new RegExp(`^(?:${pattern})$`);
      for (const prefix of prefixes) expect(prefix, `${region} (${code})`).toMatch(exact);
    }
  });

  it('lists every international prefix the phone library accepts', () => {
    const metadata = new Metadata();
    for (const [region, code] of phoneCountries) {
      if (exceptions.has(region)) continue;
      metadata.selectNumberingPlan(region as CountryCode);
      const pattern = metadata.numberingPlan?.IDDPrefix();
      expect(pattern, region).toBeTruthy();
      const prefixes = internationalPrefixList(code);
      const expanded = expandIdd(pattern!);
      if (keepsInternationalPrefix(code)) {
        for (const form of expanded) {
          expect(prefixes.some(prefix => form.startsWith(prefix)), `${region} (${code}): ${form}`).toBe(true);
        }
      } else {
        for (const form of expanded) {
          expect(prefixes, `${region} (${code}): ${form}`).toContain(form);
        }
      }
    }
  });

  it('normalizes every non-carrier prefix to an international number and avoids local mobile starts', () => {
    const localStarts = new Map<string, string>();
    for (const [region, code] of phoneCountries) {
      if (!exceptions.has(region) && !keepsInternationalPrefix(code)) {
        for (const prefix of internationalPrefixList(code)) {
          expect(normalizePhone(joinPhone(region, `${prefix} 44 20 7946 0018`), region), `${region} (${code}) ${prefix}`).toBe('+442079460018');
        }
      }
      const example = getExampleNumber(region as CountryCode, examples);
      if (!example || localStarts.has(region)) continue;
      const national = example.formatNational().replace(/\D/g, '');
      const prefixes = internationalPrefixList(callingCode(region)!);
      const conflict = prefixes.find(prefix => national.startsWith(prefix));
      expect(conflict, `${region} (${code}) national ${national}`).toBeUndefined();
    }
  });

  it('splits a stored number back into a choice and a number', () => {
    expect(splitPhone('+1 604 555 0123', 'CA')).toEqual({ country: 'CA', number: '604 555 0123' });
    expect(splitPhone('+44 20 7946 0018', 'CA')).toEqual({ country: '', number: '+44 20 7946 0018' });
    expect(splitPhone('604 555 0123', 'CA')).toEqual({ country: 'CA', number: '604 555 0123' });
    expect(splitPhone('604 555 0123', null)).toEqual({ country: '', number: '604 555 0123' });
    expect(splitPhone(null, 'CA')).toEqual({ country: 'CA', number: '' });
  });

  it('offers one labelled choice per region, sorted by label', () => {
    const options = phoneCountryOptions('en');
    expect(options).toHaveLength(phoneCountries.length);
    expect(options).toContainEqual({ value: 'CA', callingCode: '1', label: 'Canada (+1)' });
    const labels = options.map(option => option.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
  });
});
