// SPDX-License-Identifier: AGPL-3.0-only
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/** The country when the phone library supports it, else undefined: an unsupported or unset country counts as none. */
export function supportedCountry(country: unknown): string | undefined {
  return typeof country === 'string' && isSupportedCountry(country.toUpperCase()) ? country : undefined;
}
/** A consentable SMS number. No country means an explicit international number is required. */
export function normalizePhone(phone: string | null | undefined, country?: string | null): string | null {
  if (!phone || phone.length > 100) return null;
  const region = country?.toUpperCase();
  const defaultCountry = region && isSupportedCountry(region) ? region as CountryCode : undefined;
  try {
    const parsed = parsePhoneNumberFromString(phone.trim(), { ...(defaultCountry ? { defaultCountry } : {}), extract: false });
    return parsed && !parsed.ext && parsed.isValid() ? parsed.number : null;
  } catch { return null; }
}
/** The calling code of a valid international number, such as `1` for `+16045550123`. */
export function callingCodeOf(phone: string | null | undefined): string | null {
  if (!phone || phone.length > 100) return null;
  try {
    const parsed = parsePhoneNumberFromString(phone.trim(), { extract: false });
    return parsed && !parsed.ext && parsed.isValid() ? parsed.countryCallingCode : null;
  } catch { return null; }
}
/** Like normalizePhone, for a national number read with a calling code instead of a country. Only for the owner's own SMS test number. */
export function normalizePhoneWithCallingCode(phone: string | null | undefined, callingCode: string): string | null {
  if (!phone || phone.length > 100) return null;
  try {
    const parsed = parsePhoneNumberFromString(phone.trim(), { defaultCallingCode: callingCode, extract: false });
    return parsed && !parsed.ext && parsed.isValid() ? parsed.number : null;
  } catch { return null; }
}
