// SPDX-License-Identifier: AGPL-3.0-only
// Mounted only into the disposable screenshot container, never into an application image.
const NativeDate = Date, instant = NativeDate.parse('2026-11-16T12:00:00.000Z');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
