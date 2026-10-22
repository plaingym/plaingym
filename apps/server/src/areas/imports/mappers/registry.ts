// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../pipeline.messages.js';
import type { Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { ImportIssue, ImportMapper, ImportPlanRequest, ImportPreviewRow } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../../core/interfaces/common.js';
import type { CsvRow } from '../pipeline.csv.js';

export interface PlannedRow extends ImportPreviewRow { issues: ImportIssue[] }
export interface MapperContext extends MutationContext {
  clock: Clock;
  runId: string;
  /** Complete immutable source for deterministic within-file duplicate detection after a restart. */
  sourceRows: readonly CsvRow[];
}
/** Analyze must be read-only. Commit uses only the supplied short transaction and audits its domain writes. */
export interface CsvMapper {
  id: ImportMapper;
  available: boolean;
  analyze(tx: Pick<Transaction, 'select'>, rows: readonly CsvRow[], plan: ImportPlanRequest, context: MapperContext): Promise<PlannedRow[]>;
  commit(tx: Transaction, rows: readonly PlannedRow[], context: MapperContext): Promise<number>;
}
export function mapperStub(id: ImportMapper): CsvMapper {
  return { id, available: false,
    async analyze(_tx, rows) { return rows.map((row) => ({ ...row, action: 'error', duplicateIds: [],
      issues: [{ rowNumber: row.rowNumber, column: null, code: 'unknown_reference', message: t('imports/pipeline:mapperUnavailable') }] })); },
    async commit() { throw new Error('Import mapper is unavailable'); },
  };
}
export class MapperRegistry {
  readonly #mappers = new Map<ImportMapper, CsvMapper>();
  constructor(mappers: readonly CsvMapper[]) {
    for (const mapper of mappers) {
      if (this.#mappers.has(mapper.id)) throw new Error('Duplicate import mapper');
      this.#mappers.set(mapper.id, mapper);
    }
  }
  get(id: ImportMapper): CsvMapper {
    const mapper = this.#mappers.get(id);
    if (!mapper) throw new Error('Unknown import mapper');
    return mapper;
  }
}
