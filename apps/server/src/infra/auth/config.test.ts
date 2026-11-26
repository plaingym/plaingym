// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { tenancyMode } from '../../core/tenancy.js';
import { authConfig } from './config.js';

const base = { AUTH_SECRET: 'config-test-secret-with-at-least-32-characters' };

describe('AUTH_PASSWORD_LOGIN', () => {
  it.each([
    ['AUTO', 'auto'],
    [' On ', 'on'],
    ['OFF', 'off'],
    ['', 'auto'],
    ['   ', 'auto'],
    [undefined, 'auto'],
  ])('reads %j as %s', (value, mode) => {
    expect(authConfig({ ...base, AUTH_PASSWORD_LOGIN: value }, false).passwordMode).toBe(mode);
  });

  it('enables passwords according to the normalized value', () => {
    expect(authConfig({ ...base, AUTH_PASSWORD_LOGIN: ' On ' }, true).passwordEnabled).toBe(true);
    expect(authConfig({ ...base, AUTH_PASSWORD_LOGIN: 'AUTO' }, false).passwordEnabled).toBe(true);
    expect(authConfig({ ...base, AUTH_PASSWORD_LOGIN: 'OFF' }, false).passwordEnabled).toBe(false);
  });

  it('names the allowed values and the value read', () => {
    expect(() => authConfig({ ...base, AUTH_PASSWORD_LOGIN: 'maybe' }, false))
      .toThrow('AUTH_PASSWORD_LOGIN must be auto, on or off (got "maybe")');
  });

  it('cuts a long value to 40 characters', () => {
    expect(() => authConfig({ ...base, AUTH_PASSWORD_LOGIN: 'x'.repeat(60) }, false))
      .toThrow(`(got "${'x'.repeat(40)}")`);
  });
});

describe('TENANCY', () => {
  const multi = { ...base, TENANCY: 'multi', SMTP_HOST: 'smtp.example.test' };

  it('stays exact and names the allowed values and the value read', () => {
    expect(() => authConfig({ ...base, TENANCY: 'MULTI' })).toThrow('TENANCY must be single or multi (got "MULTI")');
    expect(() => tenancyMode('Single')).toThrow('TENANCY must be single or multi (got "Single")');
  });

  it('cuts a long value to 40 characters', () => {
    const message = `(got "${'x'.repeat(40)}")`;
    expect(() => authConfig({ ...base, TENANCY: 'x'.repeat(60) })).toThrow(message);
    expect(() => tenancyMode('x'.repeat(60))).toThrow(message);
  });

  it('requires password login off in multi mode, judged on the normalized value', () => {
    expect(authConfig({ ...multi, AUTH_PASSWORD_LOGIN: 'OFF' }).passwordMode).toBe('off');
    expect(() => authConfig({ ...multi, AUTH_PASSWORD_LOGIN: 'On' }))
      .toThrow('TENANCY=multi requires AUTH_PASSWORD_LOGIN=off');
  });
});
