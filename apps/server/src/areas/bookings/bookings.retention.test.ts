// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { defaultSucceededRetentionDays } from '../../infra/jobs/index.js';
import { promotionNoticeDays } from './bookings.delivery.js';

it('keeps the promotion recovery window equal to the runtime queue retention', async () => {
  const source = await readFile(new URL('../../core/runtime.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true);
  const retentions: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'PostgresJobs'
      && ts.isVariableDeclaration(node.parent) && node.parent.name.getText(file) === 'queue') {
      const options = node.arguments?.[0];
      expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
      if (options && ts.isObjectLiteralExpression(options)) {
        // Spreads could hide an override, so a change to runtime composition requires updating this check.
        expect(options.properties.some(ts.isSpreadAssignment)).toBe(false);
        const retention = options.properties.find(prop => ts.isPropertyAssignment(prop) && prop.name.getText(file) === 'retention');
        expect(retention && ts.isPropertyAssignment(retention) && ts.isObjectLiteralExpression(retention.initializer)).toBe(true);
        if (retention && ts.isPropertyAssignment(retention) && ts.isObjectLiteralExpression(retention.initializer)) retentions.push(retention.initializer);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(retentions).toHaveLength(1);
  const retention = retentions[0]!;
  expect(retention.properties.some(ts.isSpreadAssignment)).toBe(false);
  const succeeded = retention.properties.find(prop => prop.name?.getText(file) === 'succeededDays');
  let days = defaultSucceededRetentionDays;
  if (succeeded) {
    expect(ts.isPropertyAssignment(succeeded) && ts.isNumericLiteral(succeeded.initializer)).toBe(true);
    if (ts.isPropertyAssignment(succeeded) && ts.isNumericLiteral(succeeded.initializer)) days = Number(succeeded.initializer.text);
  }
  expect(promotionNoticeDays).toBe(days);
});
