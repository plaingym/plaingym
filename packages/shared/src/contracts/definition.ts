// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';
import type { RoutePermission } from '../permissions.js';

/** HTTP declarations use flat input schemas and a JSON response schema.
 * successStatus defaults to 200; creation endpoints may explicitly select 201.
 * Every additional permission is conjunctive and must run before validation.
 */
export interface EndpointContract {
  readonly method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  readonly path: string;
  readonly permission: RoutePermission;
  readonly additionalPermissions?: readonly RoutePermission[];
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  /** Request body media type defaults to application/json. */
  readonly contentType?: 'application/json' | 'multipart/form-data';
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  readonly successStatus?: 200 | 201;
}
