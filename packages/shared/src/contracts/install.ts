// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { RawEndpointContract } from './definition.js';

export const installHealthSchema = z.object({ status: z.literal('ok'), version: z.string(), commit: z.string() });
export const installSourceSchema = z.object({ data: z.object({ url: z.url() }) });
/** The document is produced by the server's OpenAPI generator. */
export const installOpenApiSchema = z.custom<{ openapi: string; info: { title: string; version: string } }>()
  .meta({ type: 'object', description: 'OpenAPI 3.0 document' });

/** Liveness and the source routes need no configured gym or session; the OpenAPI document runs after both. */
export const installContracts = {
  health: { method: 'get', path: '/healthz', permission: { kind: 'public' },
    responses: { 200: { description: 'Install liveness', content: { 'application/json': { schema: installHealthSchema } } } } },
  source: { method: 'get', path: '/api/source', permission: { kind: 'public' },
    responses: { 200: { description: 'Running source URL', content: { 'application/json': { schema: installSourceSchema } } } } },
  sourceRedirect: { method: 'get', path: '/source', permission: { kind: 'public' },
    responses: { 302: { description: 'Source code', headers: { Location: { schema: { type: 'string', format: 'uri' } } } } } },
  openApi: { method: 'get', path: '/api/openapi.json', permission: { kind: 'public' },
    responses: { 200: { description: 'OpenAPI document', content: { 'application/json': { schema: installOpenApiSchema } } } } },
  cspReport: { method: 'post', path: '/csp-report', permission: { kind: 'public' },
    responses: { 204: { description: 'Report received (or ignored)' } } },
  uploadDownload: { method: 'get', path: '/api/uploads/download', permission: { kind: 'public' },
    responses: { 200: { description: 'Signed file download', content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } } } } },
  stripeWebhook: { method: 'post', path: '/webhooks/stripe', permission: { kind: 'public' },
    responses: {
      200: { description: 'Stored, duplicate, or unrelated event', content: { 'application/json': { schema: z.object({ received: z.literal(true) }) } } },
      400: { description: 'Invalid webhook', content: { 'application/json': { schema: z.object({ error: z.literal('webhook_invalid') }) } } },
    } },
} as const satisfies Record<string, RawEndpointContract>;
