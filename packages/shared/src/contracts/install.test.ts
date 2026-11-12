// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RawEndpointContract } from './index.js';
import { installContracts, installHealthSchema, installSourceSchema } from './index.js';

describe('install response validation', () => {
  it('types raw endpoints and preserves their status codes and media types', () => {
    expectTypeOf<typeof installContracts.cspReport>().toExtend<RawEndpointContract>();
    expectTypeOf<'invalid'>().not.toExtend<RawEndpointContract['method']>();
    expectTypeOf<{ kind: 'invalid' }>().not.toExtend<RawEndpointContract['permission']>();
    expect(installContracts.cspReport).toEqual({ method: 'post', path: '/csp-report',
      permission: { kind: 'public' }, responses: { 204: { description: 'Report received (or ignored)' } } });
    expect(installContracts.uploadDownload.path).toBe('/api/uploads/download');
    expect(installContracts.uploadDownload.responses[200].content['application/octet-stream'].schema.meta()).toEqual({ format: 'binary' });
    expect(installContracts.stripeWebhook.path).toBe('/webhooks/stripe');
    const webhook = installContracts.stripeWebhook.responses;
    expect(webhook[200].content['application/json'].schema.parse({ received: true })).toEqual({ received: true });
    expect(webhook[400].content['application/json'].schema.parse({ error: 'webhook_invalid' })).toEqual({ error: 'webhook_invalid' });
  });
  it('keeps every install endpoint public: their callers (Stripe, browsers, signed links) carry no session', () => {
    for (const [name, endpoint] of Object.entries(installContracts)) expect(endpoint.permission, name).toEqual({ kind: 'public' });
  });
  it('keeps the install liveness and source shapes', () => {
    const ok = { status: 'ok', version: '0.4.0', commit: 'abc1234' };
    expect(installHealthSchema.parse(ok)).toEqual(ok);
    expect(installHealthSchema.safeParse({ ...ok, status: 'unhealthy' }).success).toBe(false);
    expect(installSourceSchema.safeParse({ data: { url: 'https://example.test/source' } }).success).toBe(true);
    expect(installSourceSchema.safeParse({ data: { url: 'not a URL' } }).success).toBe(false);
    expect(installContracts.sourceRedirect.responses[302].headers.Location.schema.format).toBe('uri');
    expect(installContracts.openApi.responses[200].content['application/json'].schema.meta()).toEqual({ type: 'object', description: 'OpenAPI 3.0 document' });
  });
});
