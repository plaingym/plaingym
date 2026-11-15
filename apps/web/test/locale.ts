// SPDX-License-Identifier: AGPL-3.0-only
// Explicit defaults also work on Windows, where LANG does not select the ICU locale.
const NativeNumberFormat = Intl.NumberFormat;
function TestNumberFormat(locale?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
  return new NativeNumberFormat(locale ?? 'en', options);
}
// Preserve static methods and allow individual tests to spy on this constructor.
Object.setPrototypeOf(TestNumberFormat, NativeNumberFormat);
TestNumberFormat.prototype = NativeNumberFormat.prototype;
Object.defineProperty(Intl, 'NumberFormat', { value: TestNumberFormat, configurable: true, writable: true });

// Date assertions share the same stable default; explicit locale tests still pass theirs through.
const NativeDateTimeFormat = Intl.DateTimeFormat;
function TestDateTimeFormat(locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
  return new NativeDateTimeFormat(locale ?? 'en', options);
}
Object.setPrototypeOf(TestDateTimeFormat, NativeDateTimeFormat);
TestDateTimeFormat.prototype = NativeDateTimeFormat.prototype;
Object.defineProperty(Intl, 'DateTimeFormat', { value: TestDateTimeFormat, configurable: true, writable: true });
