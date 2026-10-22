// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  Registry,
  createWebRegistries,
  AppError,
  errorResponse,
  dataResponse,
  contentPackSchema,
} from './index.js';
import { loadLocale, translatorFor } from '../../../locales/loader.js';

describe('localization', () => {
  it('loads namespaces, ignores license metadata and other languages, and interpolates without interpreting markup', () => {
    const files = {
      'en/portal/access.json': { $comment: 'license', welcome: 'Hello {name}', balance: '{cents} cents' },
      'fr/portal/access.json': { welcome: 'Bonjour' },
    };
    const t = translatorFor(files);
    expect(t('portal/access:welcome', { name: '<Ada>' })).toBe('Hello <Ada>');
    expect(t('portal/access:balance', { cents: 0 })).toBe('0 cents');
    expect(t('portal/access:missing')).toBe('portal/access:missing');
    expect(t('portal/access:welcome')).toBe('Hello {name}');
    expect(t('portal/access:$comment')).toBe('portal/access:$comment');
    expect(translatorFor(files, 'fr')('portal/access:welcome')).toBe('Bonjour');
    expect(createTranslator({})('bad-key')).toBe('bad-key');
  });
  it('rejects invalid and duplicate namespaces and does not read prototype properties', () => {
    expect(() => loadLocale({ 'en/a/b.json': { key: 2 } })).toThrow('Invalid translation');
    expect(() => loadLocale({ 'en/a/b.json': [] })).toThrow('Invalid locale');
    expect(() => loadLocale({ 'en/a/b.json': {}, './en/a/b.json': {} })).toThrow('Duplicate namespace');
    expect(createTranslator({})('constructor:name')).toBe('constructor:name');
  });
});
describe('registries', () => {
  it('rejects duplicates, sorts deterministically, and filters modules without losing core entries', () => {
    const registry = new Registry<{ id: string; order?: number; moduleId?: string }>();
    registry.registerAll([{ id: 'z' }, { id: 'b', order: -1, moduleId: 'site' }, { id: 'a' }]);
    expect(registry.all().map((e) => e.id)).toEqual(['b', 'a', 'z']);
    expect(registry.forModules(new Set()).map((e) => e.id)).toEqual(['a', 'z']);
    expect(registry.forModules(new Set(['site']))).toHaveLength(3);
    expect(() => registry.register({ id: 'a' })).toThrow('Duplicate');
    expect(() => registry.register({ id: '' })).toThrow('empty');
  });
  it('composes contributions without importing another feature component', () => {
    const component = () => null;
    const registries = createWebRegistries([
      {
        memberTabs: [
          {
            id: 'progress',
            labelKey: 'ranks/ranks:title',
            permission: { kind: 'staff', capability: 'members.read' },
            component,
            enabled: true,
          },
        ],
      },
    ]);
    expect(registries.memberTabs.all()[0]?.component).toBe(component);
    expect(registries.adminNav.all()).toEqual([]);
  });
});
describe('responses and packs', () => {
  it('redacts unknown errors while preserving declared safe validation details', () => {
    expect(errorResponse(new Error('database password'), 'request')).toEqual({
      error: { code: 'internal', message: 'An unexpected error occurred.' },
      requestId: 'request',
    });
    const error = new AppError('invalid_request', 'Invalid name', { name: ['Required'] });
    expect(error.status).toBe(400);
    expect(errorResponse(error, 'request').error.details).toEqual({ name: ['Required'] });
    expect(dataResponse({ id: '1' })).toEqual({ data: { id: '1' } });
  });
  const pack = {
    version: 1,
    id: 'sample',
    name: 'Sample',
    rankSystems: [
      {
        id: 'levels',
        name: 'Levels',
        ranks: [{ id: 'first', name: 'First', subRanks: [{ id: 'one', name: 'One' }] }],
      },
    ],
    programs: [{ id: 'basics', name: 'Basics', rankSystemId: 'levels' }],
    classTags: [{ id: 'open', name: 'Open' }],
  };
  it('validates versioned programs, ranks, sub-ranks and class tags', () => {
    expect(contentPackSchema.parse(pack)).toEqual(pack);
    expect(contentPackSchema.safeParse({ ...pack, version: 2 }).success).toBe(false);
    expect(contentPackSchema.safeParse({ ...pack, extra: [] }).success).toBe(false);
    expect(
      contentPackSchema.safeParse({
        ...pack,
        programs: [{ id: 'basics', name: 'Basics', rankSystemId: 'missing' }],
      }).success,
    ).toBe(false);
    expect(
      contentPackSchema.safeParse({ ...pack, classTags: [...pack.classTags, ...pack.classTags] }).success,
    ).toBe(false);
  });
});
