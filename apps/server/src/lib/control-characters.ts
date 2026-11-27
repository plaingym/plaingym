// SPDX-License-Identifier: AGPL-3.0-only
/**
 * True when the value holds a control character (U+0000 to U+001F, U+007F to U+009F)
 * or a line or paragraph separator (U+2028, U+2029), which no name or phone number needs.
 * Written with property escapes so no such character appears in the source.
 */
export const hasControlCharacter = (value: string) => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
