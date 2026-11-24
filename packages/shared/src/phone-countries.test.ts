// SPDX-License-Identifier: AGPL-3.0-only
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
import { callingCode, internationalPrefix, joinPhone, keepsInternationalPrefix, phoneCountries, phoneCountryOptions, splitPhone } from './phone-countries.js';

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
    expect(internationalPrefix('1')).toBe('011');
    expect(internationalPrefix('81')).toBe('010');
    expect(internationalPrefix('7')).toBe('810');
    expect(internationalPrefix('44')).toBe('00');
    expect(keepsInternationalPrefix('55')).toBe(true);
    expect(keepsInternationalPrefix('44')).toBe(false);

    expect(joinPhone('GB', '0044 7700 900123')).toBe('+44 7700 900123');
    for (const [region, typed, expected] of [
      ['GB', '0044 20 7946 0018', '+44 20 7946 0018'],
      ['US', '011 44 20 7946 0018', '+44 20 7946 0018'],
      ['US', '(011) 44-20.7946 0018', '+44-20.7946 0018'],
    ] as const) {
      const joined = joinPhone(region, typed);
      expect(joined).toBe(expected);
      expect(normalizePhone(joined, 'US')).toBe('+442079460018');
      expect(normalizePhone(joined, null)).toBe('+442079460018');
    }

    expect(joinPhone('JP', '010 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('RU', '810 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('RU', '8 10 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('AU', '0011 44 20 7946 0018')).toBe('+44 20 7946 0018');

    expect(joinPhone('JP', '03 1234 5678')).toBe('+81 03 1234 5678');
    expect(joinPhone('GB', '07700 900123')).toBe('+44 07700 900123');
    expect(joinPhone('US', '0044 20 7946 0018')).toBe('+1 0044 20 7946 0018');
    expect(joinPhone('GB', '00')).toBe('00');
    expect(joinPhone('BR', '0021 44 20 7946 0018')).toBe('0021 44 20 7946 0018');
    expect(joinPhone('CV', '0 44 20 7946 0018')).toBe('+44 20 7946 0018');
    expect(joinPhone('CV', '00 44 20 7946 0018')).toBe('00 44 20 7946 0018');
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
