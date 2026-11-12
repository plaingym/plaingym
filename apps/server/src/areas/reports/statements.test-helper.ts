// SPDX-License-Identifier: AGPL-3.0-only
// Test-only app-role connection; every measured read still goes through the real forGym scope.
// eslint-disable-next-line no-restricted-imports, database/system-tables
import { openConnection, scopedDatabase } from '@plaingym/db/client';

export interface ReportPlanNode {
  'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string;
  'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number;
  'Shared Hit Blocks': number; 'Shared Read Blocks': number; Plans?: ReportPlanNode[];
  'Join Filter'?: string; 'Hash Cond'?: string; 'Merge Cond'?: string;
  'Index Cond'?: string;
}
export interface ReportPlan { Plan: ReportPlanNode; 'Planning Time': number; 'Execution Time': number }

/** Counts actual driver statements; optional plans replay the captured SQL and binds under app-role RLS, outside the timer. */
export async function measureReportStatements<T>(appUrl: string, run: (scope: ReturnType<typeof scopedDatabase>['forGym']) => Promise<T>, explain = false) {
  const connection = openConnection(appUrl, 1);
  const statements: string[] = [];
  const captured: { query: string; parameters: NonNullable<Parameters<typeof connection.sql.unsafe>[1]>; gymId: string | undefined }[] = [];
  const parameterCounts: number[] = [];
  let gymId: string | undefined;
  const isReport = (query: string) => !/^\s*(begin|commit|rollback)\b/i.test(query) && !query.includes("set_config('app.gym_id'");
  try {
    // Initialize postgres.js type metadata before measuring the report itself.
    const reserved = await connection.sql.reserve();
    reserved.release();
    if (explain) await connection.sql`set statement_timeout = '30s'`;
    connection.sql.options.debug = (_connection, query, parameters) => {
      statements.push(query);
      if (query.includes("set_config('app.gym_id'")) gymId = String(parameters[0]);
      if (isReport(query)) {
        parameterCounts.push(parameters.length);
        if (explain) captured.push({ query, parameters: [...parameters], gymId });
      }
    };
    const start = performance.now();
    const result = await run(scopedDatabase(connection.db).forGym);
    const milliseconds = performance.now() - start;
    const reportStatements = statements.filter(isReport);
    connection.sql.options.debug = false;
    const plans: ReportPlan[] = [];
    if (explain) await connection.sql.begin(async sql => {
      for (const statement of captured) {
        if (!statement.gymId) throw new Error('Cannot replay report SQL without a captured gym scope');
        await sql`select set_config('app.gym_id', ${statement.gymId}, true)`;
        const [row] = await sql.unsafe<{ 'QUERY PLAN': ReportPlan[] }[]>(
          'explain (analyze, buffers, format json) ' + statement.query, statement.parameters);
        plans.push(row!['QUERY PLAN'][0]!);
      }
    });
    return { result, milliseconds, statements, reportStatements, parameterCounts, plans };
  } finally { await connection.close(); }
}
