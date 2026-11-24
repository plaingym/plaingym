// SPDX-License-Identifier: AGPL-3.0-only
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
import { callingCode, internationalPrefix, joinPhone, phoneCountries, phoneCountryOptions, splitPhone } from './phone-countries.js';

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

  it('sends a number typed with the chosen country\'s international prefix as typed', () => {
    expect(internationalPrefix('1')).toBe('011');
    expect(internationalPrefix('44')).toBe('00');
    expect(joinPhone('GB', '0044 7700 900123')).toBe('0044 7700 900123');
    // The phone library reads the prefix; 07700 900xxx is a fictional range it holds invalid, so the London number checks the parse.
    expect(joinPhone('GB', '0044 20 7946 0018')).toBe('0044 20 7946 0018');
    expect(normalizePhone('0044 20 7946 0018', 'GB')).toBe('+442079460018');
    expect(normalizePhone('011 44 20 7946 0018', 'US')).toBe('+442079460018');
    expect(joinPhone('US', '011 44 20 7946 0018')).toBe('011 44 20 7946 0018');
    expect(joinPhone('US', '(011) 44-20.7946 0018')).toBe('(011) 44-20.7946 0018');
    expect(joinPhone('GB', '07700 900123')).toBe('+44 07700 900123');
    expect(joinPhone('US', '0044 20 7946 0018')).toBe('+1 0044 20 7946 0018');
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
