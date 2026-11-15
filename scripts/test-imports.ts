// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

interface ModuleReference { specifier: string; readsFiles: boolean }
const reader = /^(?:readFile(?:Sync)?|readdir(?:Sync)?|glob(?:Sync)?|createReadStream|open(?:Sync)?|opendir(?:Sync)?|promises)$/;
const filesystem = /^(?:node:)?fs(?:\/promises)?$/;

/** Runtime imports and re-exports, including literal dynamic imports. Type-only edges do not execute. */
export function parseTestImports(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const references: ModuleReference[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      const importing = ts.isImportDeclaration(node), clause = importing ? node.importClause : node.exportClause;
      if (importing ? node.importClause?.isTypeOnly : node.isTypeOnly) return;
      const bindings = clause && (ts.isNamedImports(clause) || ts.isNamedExports(clause)) ? clause.elements
        : importing && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements : undefined;
      const defaultImport = importing && !!node.importClause?.name;
      if (!defaultImport && bindings?.length && bindings.every(binding => binding.isTypeOnly)) return;
      const specifier = node.moduleSpecifier.text;
      references.push({ specifier, readsFiles: filesystem.test(specifier) && (defaultImport || !bindings
        || bindings.some(binding => !binding.isTypeOnly && reader.test((binding.propertyName ?? binding.name).text))) });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      references.push({ specifier, readsFiles: filesystem.test(specifier) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { source, references };
}

/** Resolve source extensions consistently for test-support imports written with emitted JS extensions. */
export function resolveTestImport(file: string, specifier: string, exists: (file: string) => boolean = isFile): string | undefined {
  if (!specifier.startsWith('.')) return;
  const path = resolve(dirname(file), specifier), base = path.replace(/\.[cm]?[jt]sx?$/, '');
  // TypeScript sources win over an emitted file of the same name; a directory is never a module here.
  return [...['.ts', '.tsx', '.mts', '.cts'].map(extension => base + extension), path,
    ...['.mjs', '.js', '.jsx', '.cjs'].map(extension => base + extension)].find(exists);
}
export function isFile(path: string) { return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false; }

export const testHelper = (specifier: string) => /\.test-helper(?:\.[cm]?[jt]sx?)?$/.test(specifier);
// Fixture modules need not use the .test-helper suffix. Application I/O is not a test source scan.
export const testSupport = (specifier: string) => testHelper(specifier) || /(?:^|[/._-])fixtures?(?:[/._-]|$)/.test(specifier);

export function usesDatabase(file: string, read = (path: string) => readFileSync(path, 'utf8'), exists: (file: string) => boolean = isFile,
  visiting = new Set<string>()): boolean {
  if (visiting.has(file)) return false;
  visiting.add(file);
  try {
    const { source, references } = parseTestImports(file, read(file));
    function injectsDatabase(node: ts.Node): boolean {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 'inject'
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'inject')
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'testDatabase') return true;
      return ts.forEachChild(node, injectsDatabase) ?? false;
    }
    return injectsDatabase(source) || references.some(({ specifier }) => {
      if (/^@plaingym\/db\/testing(?:\/|$)|(?:^|\/)testing\/database/.test(specifier)) return true;
      const helper = testHelper(specifier) ? resolveTestImport(file, specifier, exists) : undefined;
      return helper !== undefined && usesDatabase(helper, read, exists, visiting);
    });
  } finally { visiting.delete(file); }
}
