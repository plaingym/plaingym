// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

interface ModuleReference { specifier: string; readsFiles: boolean }
const reader = /^(?:readFile(?:Sync)?|readdir(?:Sync)?|glob(?:Sync)?|createReadStream|open(?:Sync)?|opendir(?:Sync)?|promises)$/;
const filesystem = /^(?:node:)?fs(?:\/promises)?$/;

function readsFilesystemProperty(name: ts.Node): boolean {
  if (ts.isComputedPropertyName(name)) {
    if (ts.isStringLiteralLike(name.expression)) name = name.expression;
    else return !ts.isNumericLiteral(name.expression);
  }
  // The default export exposes the full filesystem API.
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text === 'default' || reader.test(name.text) : false;
}

function readsFilesystemCall(call: ts.CallExpression): boolean {
  let expression: ts.Expression = call;
  while (ts.isAwaitExpression(expression.parent) || ts.isParenthesizedExpression(expression.parent))
    expression = expression.parent;
  const parent = expression.parent;
  if (ts.isVoidExpression(parent)
    || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.left === expression) return false;
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name))
    return parent.name.elements.some(binding => !!binding.dotDotDotToken || readsFilesystemProperty(binding.propertyName ?? binding.name));
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === expression && ts.isObjectLiteralExpression(parent.left))
    return parent.left.properties.some(property => ts.isSpreadAssignment(property) || readsFilesystemProperty(property.name));
  return !ts.isExpressionStatement(parent);
}

function moduleLoadSpecifier(call: ts.CallExpression): string | undefined {
  const [argument] = call.arguments;
  if (!argument || !ts.isStringLiteralLike(argument)) return;
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(callee) && callee.text === 'require') return argument.text;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require'
    && ts.isIdentifier(callee.expression) && callee.expression.text === 'module') return argument.text;
  if (ts.isCallExpression(callee) && (ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire'
    || ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'createRequire')) return argument.text;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule' && isBuiltin(argument.text)) {
    const target = callee.expression;
    if (ts.isIdentifier(target) && target.text === 'process') return argument.text;
    if (ts.isPropertyAccessExpression(target) && target.name.text === 'process'
      && ts.isIdentifier(target.expression) && target.expression.text === 'globalThis') return argument.text;
  }
  if (ts.isIdentifier(callee) && callee.text === 'getBuiltinModule' && isBuiltin(argument.text)) return argument.text;
}

/** Runtime imports, re-exports and literal module loads. Type-only edges do not execute. */
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
      references.push({ specifier, readsFiles: filesystem.test(specifier) && (!importing || !!clause) && (defaultImport || !bindings
        || bindings.some(binding => !binding.isTypeOnly && readsFilesystemProperty(binding.propertyName ?? binding.name))) });
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      const specifier = node.moduleReference.expression.text;
      references.push({ specifier, readsFiles: filesystem.test(specifier) });
    }
    if (ts.isCallExpression(node)) {
      const specifier = moduleLoadSpecifier(node);
      if (specifier !== undefined) references.push({ specifier, readsFiles: filesystem.test(specifier) && readsFilesystemCall(node) });
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
      const support = testSupport(specifier) ? resolveTestImport(file, specifier, exists) : undefined;
      return support !== undefined && usesDatabase(support, read, exists, visiting);
    });
  } finally { visiting.delete(file); }
}
