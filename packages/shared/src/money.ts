// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Money amounts are stored as integers in the currency's minor units, exactly as Stripe takes them: 2500 is
 * $25.00 in USD, ¥2,500 in JPY and 2.500 KWD. This module is the only place that converts between minor
 * units and the amounts people read and type; no other code multiplies or divides an amount by 100.
 *
 * The exponent comes from Stripe's currency tables rather than from `Intl`: ICU versions disagree about some
 * currencies (HUF, COP and IDR have 0 display digits in recent ICU and 2 in older ones), so the server and a
 * browser could otherwise read the same stored amount differently. `Intl` only decides how many trailing zeros
 * a display shows.
 */

/** Stripe's zero-decimal currencies: the amount is the number of whole units. */
const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
/** Stripe's three-decimal currencies, whose charge amounts end in 0. */
const stripeThreeDecimal = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
/** Three-decimal currencies Stripe doesn't charge in (ISO 4217 minor units). */
const otherThreeDecimal = new Set(['IQD', 'LYD']);
/**
 * Whole-unit currencies Stripe still represents with two decimals that are always 00 (Stripe's special cases):
 * 5 ISK is sent as 500.
 */
const wholeUnitsInTwoDecimals = new Set(['ISK', 'UGX']);

const currencyPattern = /^[A-Z]{3}$/;
const maxAmount = 2_147_483_647; // amounts are PostgreSQL integers

function code(currency: string): string {
  if (!currencyPattern.test(currency)) throw new RangeError('Expected a three-letter currency code in capitals');
  return currency;
}

/** The number of decimal places of `currency`'s minor unit: 0 for JPY, 2 for USD, 3 for KWD. */
export function currencyExponent(currency: string): number {
  const value = code(currency);
  if (zeroDecimal.has(value)) return 0;
  if (stripeThreeDecimal.has(value) || otherThreeDecimal.has(value)) return 3;
  return 2;
}

/** The smallest amount, in minor units, that a price in `currency` may step by (100 for ISK, 10 for KWD, else 1). */
export function minorUnitStep(currency: string): number {
  const value = code(currency);
  if (wholeUnitsInTwoDecimals.has(value)) return 100;
  if (stripeThreeDecimal.has(value)) return 10;
  return 1;
}

/** The decimal places a person may type for a price in `currency`. */
export function inputDecimals(currency: string): number {
  return currencyExponent(currency) - Math.log10(minorUnitStep(currency));
}

/** The `step` attribute for a price input in `currency`: "1", "0.01", ... */
export function amountInputStep(currency: string): string {
  const places = inputDecimals(currency);
  return places ? '0.' + '1'.padStart(places, '0') : '1';
}

/** The `pattern` attribute for a text price input in `currency`. */
export function amountInputPattern(currency: string): string {
  const places = inputDecimals(currency);
  return places ? '[0-9]+([.][0-9]{1,' + places + '})?' : '[0-9]+';
}

/** `amount` minor units as an exact decimal string with `places` fraction digits (places ≤ the exponent). */
function decimal(amount: number, exponent: number, places = exponent): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError('Expected an integer amount in minor units');
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(amount)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent), fraction = digits.slice(digits.length - exponent, digits.length - exponent + places);
  return sign + whole + (fraction ? '.' + fraction : '');
}

/** Per locale and currency: the locale's usual fraction digits (capped at the exponent) and formatters for both. */
const formatters = new Map<string, { usual: number; short: Intl.NumberFormat; full: Intl.NumberFormat }>();
function formatter(currency: string, locale: string) {
  const key = locale + '\u0000' + currency;
  let cached = formatters.get(key);
  if (!cached) {
    const exponent = currencyExponent(currency);
    const usual = Math.min(new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? exponent, exponent);
    const make = (minimum: number) => new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minimum, maximumFractionDigits: exponent });
    const short = make(usual);
    cached = { usual, short, full: usual === exponent ? short : make(exponent) };
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * `amount` minor units of `currency` for display in `locale` (for example ¥2,500 or $25.00). Where the locale
 * usually shows fewer digits than the exponent (ISK 5), an amount with a fraction shows every digit (ISK 5.50).
 */
export function formatMinorUnits(amount: number, currency: string, locale = 'en'): string {
  const exponent = currencyExponent(currency), value = decimal(amount, exponent);
  const { usual, short, full } = formatter(currency, locale);
  // The exact decimal string avoids binary rounding; engines without string support convert it to a number.
  return (amount % 10 ** (exponent - usual) === 0 ? short : full).format(value as `${number}`);
}

/** `amount` minor units as the plain number a price input starts with: "25.00" (USD), "2500" (JPY), "1.25" (KWD). */
export function minorUnitsToInput(amount: number, currency: string): string {
  const exponent = currencyExponent(currency), step = minorUnitStep(currency);
  return decimal(amount, exponent, amount % step === 0 ? inputDecimals(currency) : exponent);
}

/** Why an entered price was refused. */
export class AmountInputError extends Error {
  constructor(readonly reason: 'format' | 'step' | 'too_large') {
    super(reason === 'format' ? 'Invalid amount' : reason === 'step' ? 'Amount is finer than the currency allows' : 'Amount is too large');
    this.name = 'AmountInputError';
  }
}

/**
 * A non-negative price typed in major units ("25", "25.5", "25.50") as minor units of `currency`. Extra
 * precision is refused rather than rounded, so a typed price is never changed silently: "25.505" in USD, "2500.5"
 * in JPY, "5.5" in ISK and "1.255" in KWD all throw an {@link AmountInputError}. `anyMinorUnit` drops the step
 * check (not the decimal places), for amounts taken from an existing one, such as refunding part of a charged total.
 */
export function parseMinorUnits(value: string, currency: string, options: { anyMinorUnit?: boolean } = {}): number {
  const exponent = currencyExponent(currency);
  const match = /^([0-9]+)(?:[.]([0-9]+))?$/.exec(value.trim());
  if (!match || (match[2] ?? '').length > exponent) throw new AmountInputError('format');
  const units = BigInt(match[1]!) * 10n ** BigInt(exponent) + BigInt((match[2] ?? '').padEnd(exponent, '0') || '0');
  if (units > BigInt(maxAmount)) throw new AmountInputError('too_large');
  if (!options.anyMinorUnit && units % BigInt(minorUnitStep(currency)) !== 0n) throw new AmountInputError('step');
  return Number(units);
}
