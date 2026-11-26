// SPDX-License-Identifier: AGPL-3.0-only
// Mounted only into the disposable screenshot container, never into an application image.
const NativeDate = Date, instant = NativeDate.parse(process.env.CAPTURE_CLOCK_INSTANT ?? '');
if (Number.isNaN(instant)) throw new Error('CAPTURE_CLOCK_INSTANT must be an ISO instant');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
