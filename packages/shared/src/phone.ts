// SPDX-License-Identifier: AGPL-3.0-only
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

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
