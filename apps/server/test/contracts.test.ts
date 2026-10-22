// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import * as exports from '@plaingym/shared/contracts';
import { isRoutePermission } from '@plaingym/shared';
import type { EndpointContract } from '@plaingym/shared/contracts';

const directory = fileURLToPath(new URL('../../../packages/shared/src/contracts/', import.meta.url));
const modules = (await readdir(directory, { recursive: true }))
  .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
const run = promisify(execFile);
const collections = Object.entries(exports).filter(([name]) => name.endsWith('Contracts'));

describe('combined contract inventory', () => {
  it('has one owner for every HTTP method and path, including renamed parameters', () => {
    const seen = new Map<string, string>();
    expect(collections.length).toBeGreaterThan(0);
    for (const [area, endpoints] of collections) {
      for (const [name, endpoint] of Object.entries(endpoints as Record<string, EndpointContract>)) {
        const key = endpoint.method + ' ' + endpoint.path.replace(/\{[^}]+\}/g, '{}');
        expect(seen.get(key), area + '.' + name + ' duplicates ' + seen.get(key)).toBeUndefined();
        seen.set(key, area + '.' + name);
      }
    }
  });
  it('uses one flat input layout and valid permission and response declarations', () => {
    for (const [, endpoints] of collections) {
      for (const endpoint of Object.values(endpoints as Record<string, EndpointContract>)) {
        expect(endpoint).not.toHaveProperty('request');
        expect(isRoutePermission(endpoint.permission)).toBe(true);
        for (const permission of endpoint.additionalPermissions ?? []) expect(isRoutePermission(permission)).toBe(true);
        for (const schema of [endpoint.params, endpoint.query, endpoint.body]) {
          if (schema !== undefined) expect(schema).toBeInstanceOf(z.ZodType);
        }
        expect(endpoint.response).toBeInstanceOf(z.ZodType);
        expect([200, 201]).toContain(endpoint.successStatus ?? 200);
      }
    }
  });
  it.each(modules)('loads %s directly in a fresh process', async (module) => {
    // A fresh ESM cache exposes cycles that a prior barrel import can hide.
    const target = pathToFileURL(join(directory, module)).href;
    await run(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module',
      '--eval', 'await import(' + JSON.stringify(target) + ')'], { windowsHide: true, timeout: 20_000 });
  });
});
