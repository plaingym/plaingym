// SPDX-License-Identifier: AGPL-3.0-only
import { systemTables } from './system-tables.mjs';
/** @type {import('eslint').Rule.RuleModule} */
export const systemTableRule = {
  meta: { type: 'problem', schema: [], messages: { restricted: 'System table {{name}} is restricted to its declared infrastructure modules.', opaque: 'Use a statically named schema table so system-table access can be checked.', maintenance: 'Maintenance database access belongs in migrations, backup, and restore infrastructure.', rawSql: 'Raw SQL and table construction bypass the system-table check: outside reviewed infrastructure, import only query operators (eq, and, ...) from drizzle-orm and use @plaingym/db tables, or mark a reviewed exception with an eslint-disable comment that gives the reason.' } },
  create(context) {
    const file = context.filename.replaceAll('\\', '/').split('/apps/server/src/')[1] ?? '';
    const namespaces = new Set();
    // Reviewed infrastructure that needs raw SQL (job claiming, tenancy lookup, migrations, backup, restore).
    const rawSqlModule = /^(core\/(?:migrate|database|tenancy)[^/]*|infra\/jobs\/.*|areas\/health\/(?:backups|restore)[^/]*|cli\/restore[^/]*)$/.test(file);
    const maintenanceModule = /^(core\/(?:migrate|database)[^/]*|areas\/health\/(?:backups|restore)[^/]*|cli\/restore[^/]*)$/.test(file);
    /** @param {string} name @param {import('eslint').Rule.Node} node */
    function check(name, node) {
      if (['openConnection', 'withMigrationConnection', 'migrateDatabase', 'applySecurity'].includes(name) && !maintenanceModule) {
        context.report({ node, messageId: 'maintenance' });
      }
      const table = systemTables.find((entry) => entry.exportName === name);
      if (table && !table.modules.some((pattern) => new RegExp('^' + pattern + '$').test(file))) {
        context.report({ node, messageId: 'restricted', data: { name: table.name } });
      }
    }
    /** @param {string} source */
    const database = (source) => /^@plaingym\/db(?:\/|$)/.test(source) || /(?:^|\/)packages\/db\//.test(source);
    // Drizzle can name any table as text (sql`gyms`, new SQL([new StringChunk('gyms')]), pgTable('gyms', ...)),
    // so outside reviewed infrastructure app code may import only query operators as values from
    // drizzle-orm itself. Tables come from @plaingym/db, where the system-table check applies.
    /** @param {string} source */
    const orm = (source) => /^drizzle-orm(?:\/|$)/.test(source);
    const operators = new Set([
      'eq', 'ne', 'and', 'or', 'not', 'gt', 'gte', 'lt', 'lte', 'inArray', 'notInArray', 'isNull', 'isNotNull',
      'exists', 'notExists', 'between', 'notBetween', 'like', 'notLike', 'ilike', 'notIlike',
      'arrayContains', 'arrayContained', 'arrayOverlaps', 'asc', 'desc',
      'count', 'countDistinct', 'sum', 'sumDistinct', 'avg', 'avgDistinct', 'min', 'max',
    ]);
    const rawAccess = new Set(['execute', '$client']);
    /** @param {import('eslint').Rule.Node} node */
    const reportRaw = (node) => { if (file && !rawSqlModule) context.report({ node, messageId: 'rawSql' }); };
    /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' | 'ExportNamedDeclaration' }>} node */
    function declaration(node) {
      if (node.source && typeof node.source.value === 'string' && orm(node.source.value)) {
        const typeOnly = /** @type {{ importKind?: string, exportKind?: string }} */ (node);
        if (typeOnly.importKind !== 'type' && typeOnly.exportKind !== 'type') {
          for (const specifier of node.specifiers) {
            const kind = /** @type {{ importKind?: string, exportKind?: string }} */ (specifier);
            if (kind.importKind === 'type' || kind.exportKind === 'type') continue;
            const name = specifier.type === 'ImportSpecifier'
              ? (specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value))
              : specifier.type === 'ExportSpecifier' ? (specifier.local.type === 'Identifier' ? specifier.local.name : String(specifier.local.value))
              : undefined; // default and namespace imports expose everything
            if (node.source.value !== 'drizzle-orm' || name === undefined || !operators.has(name)) reportRaw(node);
          }
        }
      }
      if (!node.source || typeof node.source.value !== 'string' || !database(node.source.value)) return;
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name);
        if (specifier.type === 'ImportSpecifier') check(specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value), node);
        if (specifier.type === 'ExportSpecifier') check(specifier.local.type === 'Identifier' ? specifier.local.name : String(specifier.local.value), node);
      }
      if (/(?:\/migrate(?:\.|$)|\/security\/)/.test(node.source.value) &&
          !maintenanceModule) {
        context.report({ node, messageId: 'maintenance' });
      }
    }
    return {
      ImportDeclaration: declaration,
      ExportNamedDeclaration: declaration,
      ExportAllDeclaration(node) {
        if (typeof node.source.value === 'string' && database(node.source.value)) context.report({ node, messageId: 'opaque' });
        if (typeof node.source.value === 'string' && orm(node.source.value)) reportRaw(node);
      },
      // import('drizzle-orm') and require('drizzle-orm') expose every constructor.
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string' && orm(node.source.value)) reportRaw(node);
      },
      CallExpression(node) {
        const [argument] = node.arguments;
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && argument?.type === 'Literal'
            && typeof argument.value === 'string' && orm(argument.value)) reportRaw(node);
      },
      // Raw execution and the driver client, however they're reached: tx.execute, tx['execute'], tx.$client.
      MemberExpression(node) {
        const name = !node.computed && node.property.type === 'Identifier' ? node.property.name
          : node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value
          : node.computed && node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0 ? node.property.quasis[0]?.value.cooked
          : undefined;
        if (name && (rawAccess.has(name) || (name === 'raw' && node.object.type === 'Identifier' && node.object.name === 'sql'))) reportRaw(node);
        if (node.object.type !== 'Identifier' || !namespaces.has(node.object.name)) return;
        if (!node.computed && node.property.type === 'Identifier') check(node.property.name, node);
        else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') check(node.property.value, node);
        else context.report({ node, messageId: 'opaque' });
      },
      // const { execute } = tx
      Property(node) {
        if (node.parent?.type !== 'ObjectPattern') return;
        const key = node.key.type === 'Identifier' && !node.computed ? node.key.name
          : node.key.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : undefined;
        if (key && rawAccess.has(key)) reportRaw(node);
      },
      Identifier(node) {
        if (!namespaces.has(node.name)) return;
        const parent = node.parent;
        if (!parent || parent.type === 'ImportNamespaceSpecifier' ||
            (parent.type === 'MemberExpression' && parent.object === node) ||
            (parent.type === 'UnaryExpression' && parent.operator === 'void')) return;
        // Namespace destructuring, spreading and aliases would obscure table access.
        context.report({ node, messageId: 'opaque' });
      },
    };
  },
};
