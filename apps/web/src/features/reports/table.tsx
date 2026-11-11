// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from '../../components/ui/button.js';
import { TableContainer } from '../../components/ui/table.js';
import { downloadCsv } from './csv.js';
import { text, type ReportTable } from './data.js';

export function DataTable({ table, title, filename }: { table: ReportTable; title: string; filename: string }) {
  return <div className="min-w-0 space-y-3">
    <Button variant="outline" onClick={() => downloadCsv(table, filename)} aria-label={text('downloadNamed', { name: title })}>{text('download')}</Button>
    <TableContainer label={title}>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{title}</caption>
        <thead className="bg-muted"><tr>{table.columns.map((column, index) => <th key={index} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{column}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index} className="border-t border-border">
          {row.map((cell, column) => column === 0
            ? <th key={column} scope="row" className="whitespace-nowrap px-4 py-3 font-normal">{cell}</th>
            : <td key={column} className={'px-4 py-3 ' + (table.textColumns?.includes(column)
              ? 'min-w-48 max-w-64 whitespace-pre-wrap wrap-anywhere' : 'whitespace-nowrap')}>{cell}</td>)}
        </tr>)}</tbody>
      </table>
    </TableContainer>
  </div>;
}
