// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { systemTableRule } from './packages/db/system-table-lint.mjs';

const vendor = {
  group: [
    'better-auth', 'better-auth/**', '@better-auth/*', '@better-auth/**',
    'stripe', 'stripe/**', 'nodemailer', 'nodemailer/**',
    '@aws-sdk/*', '@aws-sdk/**', '@smithy/*', '@smithy/**',
    'pdfkit', 'pdfkit/**', 'fontkit', 'fontkit/**', 'bidi-js', 'bidi-js/**',
    'age-encryption', 'age-encryption/**',
  ],
  message: 'Vendor SDKs belong in apps/server/src/infra/.',
};
const driver = {
  group: [
    'postgres', 'postgres/**', 'pg', 'pg/**',
    'drizzle-orm/postgres-js', 'drizzle-orm/postgres-js/**',
    'drizzle-orm/node-postgres', 'drizzle-orm/node-postgres/**',
    'drizzle-orm/pg-proxy', 'drizzle-orm/pg-proxy/**',
  ],
  message: 'Database drivers and connection adapters belong in packages/db/.',
};
const rawClient = {
  regex: '(?:^@plaingym/db/|(?:^|/)packages/db/)(?:src/)?client(?:[./]|$)',
  message: 'Import scoped helpers and schema from the database package, not its client module.',
};
// Only entry points that can expose a raw handle. Schema modules, services,
// contracts and unrelated exports named client remain unrestricted.
const databaseEntrypoints = [
  '^@plaingym/db$',
  '(?:^|/)packages/db/src/index(?:[.][cm]?[jt]s)?$',
  '(?:^|/)core/(?:db|database)(?:[.][cm]?[jt]s)?$',
];
const rawNames = {
  regex: databaseEntrypoints.join('|'),
  importNames: ['default', 'db', 'client', 'sql', 'rawDb', 'maintenanceDb'],
  message: 'Use forGym or forHousehold; raw database handles stay in database/core infrastructure.',
};
const rawDatabase = [rawClient, rawNames];
const staticImports = [
  { selector: 'ImportExpression', message: 'Use static imports in server runtime code so boundaries can be checked.' },
  { selector: 'CallExpression[callee.name="require"]', message: 'Use a static import in server runtime code.' },
  { selector: 'TSImportEqualsDeclaration', message: 'Use a static import in server runtime code.' },
  {
    selector: 'ImportDeclaration[source.value=/^(node:)?module$/]',
    message: 'Do not load Node module loaders in server runtime code; use static imports.',
  },
  {
    selector: 'CallExpression[callee.name="createRequire"]',
    message: 'Do not create runtime loaders; use static imports.',
  },
];

export default defineConfig(
  {
    files: ['apps/server/src/**'],
    plugins: { database: { rules: { 'system-tables': systemTableRule } } },
    rules: { 'database/system-tables': 'error' },
  },
  { ignores: ['.worktrees/**', '**/node_modules/**', '**/dist/**', '**/coverage/**', '**/routeTree.gen.ts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': ['error', { patterns: [vendor] }],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/server/src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [vendor, driver, ...rawDatabase] }],
    },
  },
  {
    files: ['apps/server/src/**'],
    ignores: ['**/*.{test,spec}.*', '**/{test,tests,__tests__}/**'],
    rules: { 'no-restricted-syntax': ['error', ...staticImports] },
  },
  {
    files: ['apps/server/src/infra/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [driver] }] },
  },
  {
    files: ['apps/server/src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        vendor, driver,
        { regex: '(^|/)modules(/|$)', message: 'Core must not depend on feature modules.' },
      ] }],
    },
  },
  {
    files: ['apps/server/src/areas/portal/**', 'apps/server/src/public/links/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        vendor, driver, ...rawDatabase,
        {
          // Any core module could forward forGym; schema namespaces stay allowed.
          regex: [...databaseEntrypoints, '(?:^|/)core/'].join('|'),
          importNames: ['forGym'],
          message: 'Portal and signed links must use forHousehold only.',
        },
      ] }],
    },
  },
);
