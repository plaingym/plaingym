// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { members, plans, taxRates } from '../../../db/src/schema/index.js';
import {
  AppError, errorResponse, errorStatus,
  amountCentsSchema, currencySchema, dateSchema, idSchema, instantSchema,
  listResponseSchema, moneySchema, paginationMetaSchema, paginationSchema,
  revisionSchema, taxRateMillionthsSchema,
  type ErrorResponse, type Id, type IsoDate, type IsoInstant, type ListResponse,
  type Money, type Pagination, type PaginationInput, type Revision, type TaxRateMillionths,
} from './index.js';
import {
  AppError as ExistingAppError, errorResponse as existingErrorResponse,
  errorStatus as existingErrorStatus, type ErrorResponse as ExistingErrorResponse,
} from '../responses.js';

const memberId = '019a08bf-1234-7000-8000-000000000001';

describe('contract IDs and dates', () => {
  it('accepts UUIDv7 record IDs and existing UUIDs without converting them', () => {
    for (const value of [memberId, '550e8400-e29b-41d4-a716-446655440000']) {
      expect(idSchema.parse(value)).toBe(value);
    }
  });
  it.each(['1', '', 'not-a-uuid', memberId.replaceAll('-', ''),
    '019a08bf-1234-7000-0000-000000000001', ` ${memberId}`])('rejects invalid ID %j', (value) => {
    expect(idSchema.safeParse(value).success).toBe(false);
  });
  it('keeps calendar dates as strings and applies Gregorian leap-year rules', () => {
    for (const value of ['2026-10-21', '2024-02-29', '2000-02-29']) {
      expect(dateSchema.parse(value)).toBe(value);
    }
  });
  it.each(['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '2026-1-01', '2026-10-21T00:00:00Z', '', new Date('2026-10-21')])(
    'rejects invalid calendar date %j', (value) => {
      expect(dateSchema.safeParse(value).success).toBe(false);
    },
  );
  it('preserves UTC, fractional seconds, and explicit offsets across DST changes', () => {
    for (const value of ['2026-10-21T23:59:59Z', '2026-10-21T23:59:59.123456Z',
      '2026-11-01T01:30:00-07:00', '2026-11-01T01:30:00-08:00', '2026-10-21T12:00:00+05:30']) {
      expect(instantSchema.parse(value)).toBe(value);
    }
  });
  it.each(['2026-10-21', '2026-10-21T12:00:00', '2026-10-21T12:00Z',
    '2026-02-29T12:00:00Z', '2026-10-21T24:00:00Z', '2026-10-21T12:00:00+24:00',
    '2026-10-21T12:00:00+00:60', '2026-10-21T12:00:00-0700'])('rejects invalid instant %j', (value) => {
    expect(instantSchema.safeParse(value).success).toBe(false);
  });
});

describe('money, tax rates, and revisions', () => {
  it('accepts integer cents including zero and signed discount lines within database bounds', () => {
    for (const amountCents of [-2_147_483_648, -500, 0, 500, 2_147_483_647]) {
      expect(moneySchema.parse({ amountCents, currency: 'CAD' })).toEqual({ amountCents, currency: 'CAD' });
    }
  });
  it.each([1.01, '100', NaN, Infinity, -Infinity, 2_147_483_648, -2_147_483_649, null, true])(
    'rejects invalid or out-of-range cents %j', (value) => {
      expect(amountCentsSchema.safeParse(value).success).toBe(false);
    },
  );
  it('requires an explicit currency and rejects unexpected money fields', () => {
    expect(moneySchema.safeParse({ amountCents: 100 }).success).toBe(false);
    expect(moneySchema.safeParse({ currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: 100, currency: 'USD', amount: 1 }).success).toBe(false);
    expect(currencySchema.parse('USD')).toBe('USD');
    // Currency syntax matches the database, rather than a changing currency list.
    expect(currencySchema.parse('XYZ')).toBe('XYZ');
  });
  it.each(['usd', 'Usd', 'US', 'USDD', 'US1', ' USD', 'USD ', '', null])('rejects currency %j', (value) => {
    expect(currencySchema.safeParse(value).success).toBe(false);
  });
  it('accepts tax rate boundaries and fractional percentages in millionths', () => {
    for (const value of [0, 99_750, 1_000_000]) expect(taxRateMillionthsSchema.parse(value)).toBe(value);
  });
  it.each([-1, 1_000_001, 99_750.5, '99750', NaN, Infinity])('rejects tax rate %j', (value) => {
    expect(taxRateMillionthsSchema.safeParse(value).success).toBe(false);
  });
  it('requires the revision read by the client in an update shape', () => {
    const updateSchema = z.strictObject({ name: z.string(), revision: revisionSchema });
    expect(updateSchema.safeParse({ name: 'Updated' }).success).toBe(false);
    expect(updateSchema.parse({ name: 'Updated', revision: 1 }).revision).toBe(1);
    expect(revisionSchema.parse(2_147_483_647)).toBe(2_147_483_647);
  });
  it.each([0, -1, 1.5, '1', null, NaN, Infinity, 2_147_483_648])('rejects revision %j', (value) => {
    expect(revisionSchema.safeParse(value).success).toBe(false);
  });
});

describe('list pagination', () => {
  it('defaults missing bounds and parses numeric query parameters without changing JSON integers', () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(paginationSchema.parse({ limit: '100', offset: '20' })).toEqual({ limit: 100, offset: 20 });
    expect(paginationSchema.parse({ limit: 1, offset: 0 })).toEqual({ limit: 1, offset: 0 });
    expect(paginationSchema.parse({ offset: '0' })).toEqual({ limit: 50, offset: 0 });
  });
  it.each([0, -1, 101, 1.5, '', ' ', '1.0', '1e2', '0x10', '01', '+1', ' 1', '1 ',
    null, true, [], ['1'], Infinity, NaN, '9007199254740992'])('rejects invalid limit %j', (limit) => {
    expect(paginationSchema.safeParse({ limit }).success).toBe(false);
  });
  it.each([-1, 0.5, '-1', '', null, false, '9007199254740992', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid offset %j', (offset) => {
      expect(paginationSchema.safeParse({ offset }).success).toBe(false);
    },
  );
  it('requires explicit numeric response metadata, including the total count', () => {
    for (const value of [{ limit: 50, offset: 0 }, { limit: '50', offset: 0, total: 0 },
      { limit: 0, offset: 0, total: 0 }, { limit: 101, offset: 0, total: 0 },
      { limit: 50, offset: -1, total: 0 }, { limit: 50, offset: 0, total: -1 },
      { limit: 50, offset: 0, total: 0.5 }]) {
      expect(paginationMetaSchema.safeParse(value).success).toBe(false);
    }
  });
  it('validates list items and preserves the existing data envelope, including empty pages', () => {
    const schema = listResponseSchema(z.strictObject({ id: idSchema }));
    const page = { data: [{ id: memberId }], pagination: { limit: 50, offset: 0, total: 1 } };
    expect(schema.parse(page)).toEqual(page);
    expect(schema.parse({ data: [], pagination: { limit: 50, offset: 100, total: 0 } }).data).toEqual([]);
    expect(schema.safeParse({ ...page, data: [{ id: '1' }] }).success).toBe(false);
    expect(schema.safeParse({ data: page.data }).success).toBe(false);
    expect(schema.safeParse({ ...page, data: {} }).success).toBe(false);
    expect(schema.safeParse({ ...page, unexpected: true }).success).toBe(false);
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<ListResponse<{ id: string }>>();
  });
});

describe('contract integration', () => {
  it('re-exports the existing errors and uses the same conflict response for stale saves', () => {
    expect(AppError).toBe(ExistingAppError);
    expect(errorResponse).toBe(existingErrorResponse);
    expect(errorStatus).toBe(existingErrorStatus);
    const stale = new AppError('conflict', 'This record has changed. Reload before saving.');
    expect(stale.status).toBe(409);
    const response: ErrorResponse = errorResponse(stale, 'request-id');
    expect(response).toEqual({ error: { code: 'conflict', message: stale.message }, requestId: 'request-id' });
    expectTypeOf<ErrorResponse>().toEqualTypeOf<ExistingErrorResponse>();
  });
  it('exports types compatible with the locked database schema and parsed pagination', () => {
    expectTypeOf<Id>().toEqualTypeOf<typeof members.$inferSelect.id>();
    expectTypeOf<IsoDate>().toEqualTypeOf<NonNullable<typeof members.$inferSelect.dateOfBirth>>();
    expectTypeOf<IsoInstant>().toEqualTypeOf<string>();
    expectTypeOf<Money>().toEqualTypeOf<Pick<typeof plans.$inferSelect, 'amountCents' | 'currency'>>();
    expectTypeOf<Revision>().toEqualTypeOf<typeof members.$inferSelect.revision>();
    expectTypeOf<TaxRateMillionths>().toEqualTypeOf<typeof taxRates.$inferSelect.rateMillionths>();
    expectTypeOf<Pagination>().toEqualTypeOf<{ limit: number; offset: number }>();
    expectTypeOf<PaginationInput>().toEqualTypeOf<{ limit?: number | string | undefined; offset?: number | string | undefined }>();
  });
});
