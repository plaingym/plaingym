// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { assertSchemaCompatibility } from './client.js';

it('allows the previous minor within the checked floor and refuses older images before opening the database', () => {
  const schema = { SCHEMA_ROLLBACK_FLOOR: 'v1.2.0', SCHEMA_RELEASE: 'v1.3.0', SCHEMA_SNAPSHOT: '00000000-0000-4000-8000-000000000001' };
  expect(() => assertSchemaCompatibility({ ...schema, APP_VERSION: '1.2.0' })).not.toThrow();
  expect(() => assertSchemaCompatibility({ ...schema, APP_VERSION: '1.3.0' })).not.toThrow();
  expect(() => assertSchemaCompatibility({ ...schema, APP_VERSION: '1.1.9' })).toThrow(/Cannot start 1.1.9.*v1.3.0.*v1.2.0.*00000000/);
  expect(() => assertSchemaCompatibility({ ...schema, APP_VERSION: '1.3.0+3.gabc1234' })).not.toThrow();
  expect(() => assertSchemaCompatibility({ ...schema, APP_VERSION: 'dev' })).toThrow(/Invalid or missing/);
  expect(() => assertSchemaCompatibility({ APP_VERSION: '1.0.0', SCHEMA_ROLLBACK_FLOOR: 'garbage' })).toThrow(/Invalid or missing/);
});
