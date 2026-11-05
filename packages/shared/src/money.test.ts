// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AmountInputError, amountInputPattern, amountInputStep, currencyExponent, formatMinorUnits, inputDecimals, minimumChargeAmount, minorUnitStep,
  minorUnitsToInput, onMinorUnitStep, parseMinorUnits } from './money.js';

const nbsp = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');

describe('currencyExponent', () => {
  it.each([
    ['JPY', 0], ['KRW', 0], ['CLP', 0], ['VND', 0], ['XOF', 0],
    ['USD', 2], ['CAD', 2], ['EUR', 2], ['HUF', 2], ['COP', 2], ['IDR', 2], ['ISK', 2], ['UGX', 2], ['ZZZ', 2],
    ['KWD', 3], ['BHD', 3], ['JOD', 3], ['OMR', 3], ['TND', 3], ['LYD', 3],
  ])('%s has %i decimal places', (currency, exponent) => expect(currencyExponent(currency)).toBe(exponent));

  it('agrees with Intl wherever Stripe does not say otherwise', () => {
    // The lists below were written against this ICU. A Node update that brings other ICU data can fail this case with
    // no code change: review the lists against Stripe's currency tables and the new ICU, then update the version.
    const writtenFor = '78.3', icu = process.versions.icu ?? 'none';
    const why = (currency: string) => `${currency}: the lists were written for ICU ${writtenFor}; this runtime has ICU ${icu}`;
    // Stripe charges these in two decimals; recent ICU displays them with none.
    const stripeTwoDecimal = new Set(['AFN', 'ALL', 'COP', 'HUF', 'IDR', 'ISK', 'LAK', 'LBP', 'MMK', 'PKR', 'SLL', 'SOS', 'UGX', 'YER']);
    // Stripe doesn't charge in these; ISO 4217 gives them minor units that ICU doesn't display.
    const iso = new Map([['IQD', 3], ['IRR', 2], ['KPW', 2], ['SYP', 2]]);
    for (const currency of Intl.supportedValuesOf('currency')) {
      const intl = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      const expected = stripeTwoDecimal.has(currency) ? 2 : iso.get(currency) ?? intl;
      expect(currencyExponent(currency), why(currency)).toBe(expected);
    }
  });

  it('refuses anything but a three-letter code in capitals', () => {
    for (const bad of ['usd', 'US', 'USDT', '', '12A']) expect(() => currencyExponent(bad)).toThrow(RangeError);
  });
});

describe('formatMinorUnits', () => {
  it.each([
    [2500, 'JPY', '¥2,500'], [0, 'JPY', '¥0'], [-2500, 'JPY', '-¥2,500'], [1, 'JPY', '¥1'],
    [2500, 'USD', '$25.00'], [0, 'USD', '$0.00'], [-2550, 'USD', '-$25.50'], [1, 'USD', '$0.01'], [-1, 'USD', '-$0.01'],
    [2500, 'KWD', 'KWD 2.500'], [0, 'KWD', 'KWD 0.000'], [-1, 'KWD', '-KWD 0.001'], [1234567, 'KWD', 'KWD 1,234.567'],
    [500, 'ISK', 'ISK 5'], [550, 'ISK', 'ISK 5.50'], [-550, 'ISK', '-ISK 5.50'], [1050, 'HUF', 'HUF 10.50'],
    [2_147_483_647, 'USD', '$21,474,836.47'], [2_147_483_647, 'JPY', '¥2,147,483,647'],
  ])('%i in %s reads %s', (amount, currency, expected) => expect(nbsp(formatMinorUnits(amount, currency))).toBe(expected));

  it('formats in the given locale and keeps every digit', () => {
    expect(nbsp(formatMinorUnits(12345, 'CAD', 'fr-CA'))).toBe('123,45 $');
    expect(nbsp(formatMinorUnits(250000, 'JPY', 'ja'))).toBe('￥250,000');
    expect(nbsp(formatMinorUnits(1005, 'EUR', 'de'))).toBe('10,05 €');
  });

  it('never rounds: binary fractions that Number division would blur come out exact', () => {
    expect(formatMinorUnits(1_000_000_005, 'USD')).toBe('$10,000,000.05');
    expect(formatMinorUnits(2_000_000_001, 'KWD')).toBe('KWD\u00a02,000,000.001');
  });

  it('reuses one formatter per currency and locale', () => {
    const original = Intl.NumberFormat;
    // The cache means a second call for the same pair builds nothing new.
    formatMinorUnits(1, 'NOK', 'nb');
    let constructed = 0;
    (Intl as { NumberFormat: unknown }).NumberFormat = function (...args: ConstructorParameters<typeof Intl.NumberFormat>) {
      constructed++; return new original(...args);
    };
    try { formatMinorUnits(2, 'NOK', 'nb'); } finally { (Intl as { NumberFormat: unknown }).NumberFormat = original; }
    expect(constructed).toBe(0);
  });

  it('refuses amounts that are not integer minor units', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(() => formatMinorUnits(bad, 'USD')).toThrow(RangeError);
  });
});

describe('price input', () => {
  it.each([
    ['JPY', 0, 1, '1'], ['USD', 2, 1, '0.01'], ['KWD', 2, 10, '0.01'], ['ISK', 0, 100, '1'], ['UGX', 0, 100, '1'], ['LYD', 3, 1, '0.001'],
  ])('%s takes %i typed decimals in steps of %i minor units (step attribute %s)', (currency, places, step, attribute) => {
    expect([inputDecimals(currency), minorUnitStep(currency), amountInputStep(currency)]).toEqual([places, step, attribute]);
  });

  it('builds an input pattern with the typed decimals', () => {
    expect(amountInputPattern('USD')).toBe('[0-9]+([.][0-9]{1,2})?');
    expect(amountInputPattern('JPY')).toBe('[0-9]+');
    expect(amountInputPattern('ISK')).toBe('[0-9]+');
    expect(amountInputPattern('LYD')).toBe('[0-9]+([.][0-9]{1,3})?');
  });

  it.each([
    ['2500', 'JPY', 2500], ['0', 'JPY', 0], [' 2500 ', 'JPY', 2500],
    ['25', 'USD', 2500], ['25.5', 'USD', 2550], ['25.50', 'USD', 2550], ['0.01', 'USD', 1], ['0', 'USD', 0], ['0.00', 'USD', 0],
    ['2.5', 'KWD', 2500], ['1.25', 'KWD', 1250], ['1.250', 'KWD', 1250], ['0', 'KWD', 0],
    ['5', 'ISK', 500], ['5.00', 'ISK', 500], ['0.005', 'LYD', 5],
    ['21474836.47', 'USD', 2_147_483_647], ['2147483647', 'JPY', 2_147_483_647],
  ])('%j in %s is %i minor units', (value, currency, expected) => expect(parseMinorUnits(value, currency)).toBe(expected));

  it.each([
    ['2500.5', 'JPY', 'format'], ['25.505', 'USD', 'format'], ['1.2345', 'KWD', 'format'],
    ['1.255', 'KWD', 'step'], ['5.5', 'ISK', 'step'], ['5.01', 'UGX', 'step'],
    ['-25', 'USD', 'format'], ['-0', 'JPY', 'format'], ['', 'USD', 'format'], ['.5', 'USD', 'format'], ['25.', 'USD', 'format'],
    ['1e3', 'USD', 'format'], ['25,00', 'USD', 'format'], ['NaN', 'USD', 'format'],
    ['21474836.48', 'USD', 'too_large'], ['2147483648', 'JPY', 'too_large'], ['99999999999999999999', 'KWD', 'too_large'],
  ])('refuses %j in %s (%s)', (value, currency, reason) => {
    expect(() => parseMinorUnits(value, currency)).toThrow(AmountInputError);
    try { parseMinorUnits(value, currency); } catch (error) { expect((error as AmountInputError).reason).toBe(reason); }
  });

  it('takes any minor unit when asked, but never more decimal places', () => {
    expect(parseMinorUnits('1.255', 'KWD', { anyMinorUnit: true })).toBe(1255);
    expect(parseMinorUnits('5.50', 'ISK', { anyMinorUnit: true })).toBe(550);
    expect(() => parseMinorUnits('2500.5', 'JPY', { anyMinorUnit: true })).toThrow(AmountInputError);
  });

  it.each([
    [2500, 'JPY', '2500'], [0, 'JPY', '0'], [2550, 'USD', '25.50'], [0, 'USD', '0.00'], [1250, 'KWD', '1.25'], [1255, 'KWD', '1.255'],
    [500, 'ISK', '5'], [550, 'ISK', '5.50'], [-2550, 'USD', '-25.50'],
  ])('%i in %s starts an input as %j', (amount, currency, expected) => expect(minorUnitsToInput(amount, currency)).toBe(expected));

  it('round-trips every stored amount it shows in an input', () => {
    for (const currency of ['JPY', 'USD', 'KWD', 'ISK'])
      for (const amount of [0, 100, 1000, 2500, 123_400, 2_147_483_600])
        expect(parseMinorUnits(minorUnitsToInput(amount, currency), currency)).toBe(amount);
  });
});

describe('card amounts', () => {
  it.each([
    [555, 'ISK', false], [600, 'ISK', true], [1255, 'KWD', false], [1250, 'KWD', true], [1, 'USD', true], [1, 'JPY', true],
    [0, 'KWD', true], [1.5, 'USD', false],
  ])('%s %s is on the charge step: %s', (amount, currency, expected) => expect(onMinorUnitStep(amount, currency)).toBe(expected));

  it.each([
    ['USD', 50], ['CAD', 50], ['EUR', 50], ['GBP', 30], ['JPY', 50], ['KRW', 50], ['HUF', 17_500], ['MXN', 1000], ['THB', 1000],
    ['CZK', 1500], ['HKD', 400], ['KWD', null], ['ISK', null],
  ])('the minimum card charge in %s is %s minor units', (currency, expected) => expect(minimumChargeAmount(currency)).toBe(expected));

  it('refuses a malformed currency code', () => expect(() => minimumChargeAmount('usd')).toThrow(RangeError));
});
