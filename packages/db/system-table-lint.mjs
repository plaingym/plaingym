// SPDX-License-Identifier: AGPL-3.0-only
import { systemTables } from './system-tables.mjs';
/** @type {import('eslint').Rule.RuleModule} */
export const systemTableRule = {
  meta: { type: 'problem', schema: [], messages: { restricted: 'System table {{name}} is restricted to its declared infrastructure modules.', opaque: 'Use a statically named schema table so system-table access can be checked.', maintenance: 'Maintenance database access belongs in migrations, backup, and restore infrastructure.' } },
  create(context) {
    const file = context.filename.replaceAll('\\', '/').split('/apps/server/src/')[1] ?? '';
    const namespaces = new Set();
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
    /** @param {Extract<import('eslint').Rule.Node, { type: 'ImportDeclaration' | 'ExportNamedDeclaration' }>} node */
    function declaration(node) {
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
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier' || !namespaces.has(node.object.name)) return;
        if (!node.computed && node.property.type === 'Identifier') check(node.property.name, node);
        else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') check(node.property.value, node);
        else context.report({ node, messageId: 'opaque' });
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
