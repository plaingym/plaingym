// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/** Resolve literal names, unions (including array callbacks), and names passed through local helpers. */
function scanVariables(sources: Map<string, string>): Set<string> {
  sources = new Map([...sources].map(([file, source]) => [file.replaceAll('\\', '/'), source]));
  const options: ts.CompilerOptions = { allowJs: true, target: ts.ScriptTarget.ESNext, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(file.replaceAll('\\', '/'));
    return source === undefined ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, source, languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host), checker = program.getTypeChecker();
  const files = [...sources.keys()].map((file) => program.getSourceFile(file)!);
  const calls = new Map<ts.Node, ts.CallExpression[]>();
  function visit(node: ts.Node, fn: (node: ts.Node) => void) {
    fn(node); ts.forEachChild(node, (child) => visit(child, fn));
  }
  for (const file of files) visit(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (declaration) calls.set(declaration, [...(calls.get(declaration) ?? []), node]);
  });
  function literalNames(type: ts.Type): string[] | undefined {
    if (type.isStringLiteral()) return [type.value];
    if (!type.isUnion()) return undefined;
    const names = type.types.map(literalNames);
    return names.every((part) => part !== undefined) ? names.flat() : undefined;
  }
  function unresolved(node: ts.Node): never {
    const file = node.getSourceFile(), { line } = file.getLineAndCharacterOfPosition(node.getStart());
    throw new Error(`Unresolved environment variable at ${file.fileName}:${line + 1}: ${node.getText()}`);
  }
  // With noResolve, only direct local calls can supply a helper's complete argument set.
  function assertLocalCalls(fn: ts.SignatureDeclaration) {
    const declaration = ts.isFunctionDeclaration(fn) ? fn : ts.isVariableDeclaration(fn.parent) ? fn.parent : undefined;
    if (!declaration?.name || !ts.isIdentifier(declaration.name)) unresolved(fn);
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) unresolved(declaration);
    for (const file of files) visit(file, node => {
      if (ts.isExportSpecifier(node) && checker.getExportSpecifierLocalTargetSymbol(node) === symbol) unresolved(node);
      if (!ts.isIdentifier(node) || node === declaration.name || checker.getSymbolAtLocation(node) !== symbol) return;
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) unresolved(node);
    });
  }
  function namesAt(expression: ts.Expression, visiting = new Set<ts.Node>()): string[] {
    const names = literalNames(checker.getTypeAtLocation(expression));
    if (names) return names;
    const parameter = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (parameter && ts.isParameter(parameter) && !visiting.has(parameter)) {
      const fn = parameter.parent;
      assertLocalCalls(fn);
      const index = fn.parameters.indexOf(parameter);
      const arguments_ = (calls.get(fn) ?? []).map((call) => call.arguments[index]);
      if (arguments_.length && arguments_.every((argument) => argument !== undefined)) {
        return arguments_.flatMap((argument) => namesAt(argument, new Set([...visiting, parameter])));
      }
    }
    return unresolved(expression);
  }
  const names = new Set<string>();
  for (const file of files) visit(file, (node) => {
    // Reject destructuring and aliases instead of silently losing their subsequent reads.
    if (ts.isVariableDeclaration(node) && node.initializer && /(?:^|\.)env$/.test(node.initializer.getText().replaceAll(/\s/g, ''))
      && (!ts.isIdentifier(node.name) || node.name.text !== 'env')) unresolved(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && /(?:^|\.)env$/.test(node.right.getText().replaceAll(/\s/g, ''))) unresolved(node);
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    if (!/(?:^|\.)env$/.test(node.expression.getText().replaceAll(/\s/g, ''))) return;
    const found = ts.isPropertyAccessExpression(node) ? [node.name.text] : namesAt(node.argumentExpression);
    for (const name of found) if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
  });
  return names;
}

/** Variables the running server or a `gym-app` command reads: tests, fixtures and browser checks are left out. */
let cachedServerVariables: Set<string> | undefined;
function serverVariables(): Set<string> {
  if (cachedServerVariables) return cachedServerVariables;
  const files = globSync(['apps/server/src/**/*.{ts,tsx,mjs}', 'packages/db/src/**/*.{ts,tsx,mjs}'], { cwd: root })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !/\.test\.[^/]+$|\.test-helper\.[^/]+$|\.mobile-check\.mjs$|\/mobile-check\.mjs$|\/testing\/|\/scenarios\/|vitest\.[^/]*config\.ts$/.test(file));
  cachedServerVariables = scanVariables(new Map(files.map((file) => [resolve(root, file), read(file)])));
  return cachedServerVariables;
}
/** Variables the deployment Compose file interpolates, and those the image's start-up scripts read. */
function composeVariables(): Set<string> {
  const sources = ['deploy/compose.yaml', ...globSync('deploy/container/*.sh', { cwd: root })];
  return new Set(sources.flatMap((file) => [...read(file).matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name!)));
}
/** Variables the host scripts (installer and updater) read from the install's `.env`. */
function hostVariables(): Set<string> {
  return new Set(globSync('deploy/*.sh', { cwd: root })
    .flatMap((file) => [...read(file).matchAll(/\bread_env ([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name!)));
}
/** The variables named in the first column of configuration.md's tables. */
function documentedVariables(): Set<string> {
  return new Set(read('docs/configuration.md').split('\n')
    .flatMap((line) => /^\| `([A-Z][A-Z0-9_]+)` \|/.exec(line)?.[1] ?? []));
}

describe('docs/configuration.md', () => {
  it('scans TSX and JavaScript, both bracket quotes, and dynamic reads through helpers and arrays', () => {
    const sources = new Map([
      [resolve(root, 'scan-fixture.tsx'), `
        const env: Record<string, string> = {};
        env.DIRECT; env['SINGLE_QUOTED']; env["DOUBLE_QUOTED"];
        const options = { env }; options.env.QUALIFIED; options.env['QUALIFIED_BRACKET'];
        const names = ['ARRAY_FIRST', 'ARRAY_SECOND'] as const;
        names.find((name) => env[name]);
        function required(name: string) { return env[name]; }
        required('HELPER_FIRST'); required("HELPER_SECOND");
      `],
      [resolve(root, 'scan-fixture.mjs'), `process.env.MJS_VARIABLE; process.env["MJS_BRACKET"];`],
    ]);
    expect([...scanVariables(sources)].sort()).toEqual([
      'ARRAY_FIRST', 'ARRAY_SECOND', 'DIRECT', 'DOUBLE_QUOTED', 'HELPER_FIRST', 'HELPER_SECOND',
      'MJS_BRACKET', 'MJS_VARIABLE', 'QUALIFIED', 'QUALIFIED_BRACKET', 'SINGLE_QUOTED',
    ]);
  });
  it('rejects dynamic reads it cannot resolve instead of silently missing a variable', () => {
    expect(() => scanVariables(new Map([[resolve(root, 'scan-fixture.ts'),
      'declare const env: Record<string, string>, name: string; env[name];']])))
      .toThrow('Unresolved environment variable');
  });
  it('allows env as the canonical name, including an injected environment fallback', () => {
    expect([...scanVariables(new Map([[resolve(root, 'scan-fixture.ts'),
      'declare const options: { env?: Record<string, string> }; const env = options.env ?? process.env; env.CANONICAL;']]))])
      .toEqual(['CANONICAL']);
  });
  it.each([
    'const { X } = process.env;',
    'const source = process.env; source.X;',
    'let source; source = process.env; source.X;',
    "export function required(name: string) { return process.env[name]; } required('LOCAL');",
    "function read(name: string) { return process.env[name]; } read('LOCAL'); ['CALLBACK'].map(read);",
    "function read(name: string) { return process.env[name]; } read('LOCAL'); export { read };",
  ])('rejects incomplete environment scans: %s', source => {
    expect(() => scanVariables(new Map([[resolve(root, 'scan-fixture.ts'), source]]))).toThrow('Unresolved environment variable');
  });
  it('rejects an exported helper even when another source calls it', () => {
    expect(() => scanVariables(new Map([
      [resolve(root, 'scan-helper.ts'), "export function required(name: string) { return process.env[name]; } required('LOCAL');"],
      [resolve(root, 'scan-caller.ts'), "import { required } from './scan-helper'; required('IMPORTED');"],
    ]))).toThrow('Unresolved environment variable');
  });
  it('lists every variable the server reads', () => {
    const documented = documentedVariables();
    expect([...serverVariables()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });
  it('lists every variable the deployment Compose file uses', () => {
    const documented = documentedVariables();
    expect([...composeVariables()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });
  it('lists every variable the host scripts read', () => {
    const documented = documentedVariables();
    expect([...hostVariables()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });
  it('lists only variables something still reads', () => {
    const used = new Set([...serverVariables(), ...composeVariables(), ...hostVariables()]);
    expect([...documentedVariables()].filter((name) => !used.has(name)).sort()).toEqual([]);
  });
  it('finds the variables it checks', () => {
    // A broken scan would pass the checks above vacuously.
    expect(serverVariables()).toContain('APP_ENCRYPTION_KEY');
    expect(serverVariables()).toContain('BACKUP_STAGING_DIR');
    expect(composeVariables()).toContain('APP_IMAGE');
    expect(hostVariables()).toContain('RELEASE_REPOSITORY');
    expect(documentedVariables().size).toBeGreaterThan(40);
  });
});
