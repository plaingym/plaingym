// SPDX-License-Identifier: AGPL-3.0-only
import type { ReportTable } from './data.js';

/** Quote every field, retain embedded newlines and neutralize spreadsheet formula prefixes. */
export function reportCsv(table: ReportTable): string {
  const cell = (value: string) => {
    // Plain numbers can't run as formulas, so negative amounts stay numeric.
    const numeric = /^-?\d+(\.\d+)?$/.test(value);
    return '"' + (/^[=+\-@\t\r]/.test(value) && !numeric ? "'" + value : value).replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [table.columns, ...table.rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function downloadCsv(table: ReportTable, filename: string) {
  const url = URL.createObjectURL(new Blob([reportCsv(table)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  // Let the browser begin reading the Blob before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
