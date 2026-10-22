// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const identifier = 'SPDX-License-Identifier: AGPL-3.0-only';
const syntax = new Map();
for (const extension of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsonc', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.proto']) syntax.set(extension, '//');
for (const extension of ['.yml', '.yaml', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.py', '.rb', '.toml', '.ini', '.conf', '.properties', '.tf', '.r', '.pl']) syntax.set(extension, '#');
for (const extension of ['.html', '.htm', '.xml', '.svg', '.vue', '.svelte']) syntax.set(extension, '<!--');
for (const extension of ['.css', '.scss', '.less']) syntax.set(extension, '/*');
syntax.set('.sql', '--');
syntax.set('.bat', 'REM');
syntax.set('.cmd', 'REM');
const hashNames = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'Caddyfile', '.gitignore', '.gitattributes', '.npmrc', '.dockerignore', '.editorconfig']);
const data = new Set(['.json', '.md', '.txt', '.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.snap', '.csv', '.map', '.lock', '.asc']);

export function headerSyntax(path, content = '') {
  const name = basename(path);
  if (path === 'pnpm-lock.yaml') return null; // Generated dependency data, not source.
  if (hashNames.has(name) || /^(Dockerfile|Containerfile)[.]/.test(name) || /^\.env(?:\.|$)/.test(name)) return '#';
  if (/^tsconfig(?:\..+)?\.json$/.test(name)) return '//'; // TypeScript config is JSONC.
  const extension = extname(path).toLowerCase();
  if (syntax.has(extension)) return syntax.get(extension);
  if (content.startsWith('#!')) return '#';
  if (data.has(extension) || ['LICENSE', 'THIRD_PARTY_LICENSES', '.nvmrc'].includes(name)) return null;
  // Unknown tracked file types must be classified instead of silently bypassing CI.
  throw new Error(`Unclassified tracked file type: ${path}`);
}

export function hasHeader(path, content) {
  const marker = headerSyntax(path, content);
  if (!marker) return true; // Strict JSON and binary/data/doc files have no source comment header.
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  // A shebang or cloud-init's required first-line marker comes before the header.
  if (lines[0].startsWith('#!') || (marker === '#' && lines[0] === '#cloud-config')) lines.shift();
  const expected = marker === '<!--' ? `<!-- ${identifier} -->`
    : marker === '/*' ? `/* ${identifier} */` : `${marker} ${identifier}`;
  return lines[0] === expected;
}

export function trackedFiles(root) {
  return execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

export function checkHeaders(root) {
  const errors = [];
  for (const path of trackedFiles(root)) {
    try {
      if (!hasHeader(path, readFileSync(join(root, path), 'utf8'))) errors.push(`${path}: missing SPDX header or wrong comment syntax`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
