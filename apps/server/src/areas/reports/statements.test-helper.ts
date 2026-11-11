// SPDX-License-Identifier: AGPL-3.0-only
// Test-only app-role connection; every measured read still goes through the real forGym scope.
// eslint-disable-next-line no-restricted-imports, database/system-tables
import { openConnection, scopedDatabase } from '@plaingym/db/client';

/** Counts actual driver statements, including transaction/setup statements separately from report SQL. */
export async function measureReportStatements<T>(appUrl: string, run: (scope: ReturnType<typeof scopedDatabase>['forGym']) => Promise<T>) {
  const connection = openConnection(appUrl, 1);
  const statements: string[] = [];
  try {
    // Initialize postgres.js type metadata before measuring the report itself.
    const reserved = await connection.sql.reserve();
    reserved.release();
    connection.sql.options.debug = (_connection, query) => { statements.push(query); };
    const start = performance.now();
    const result = await run(scopedDatabase(connection.db).forGym);
    const reportStatements = statements.filter(query => !/^\s*(begin|commit|rollback)\b/i.test(query) && !query.includes("set_config('app.gym_id'"));
    return { result, milliseconds: performance.now() - start, statements, reportStatements };
  } finally { await connection.close(); }
}
