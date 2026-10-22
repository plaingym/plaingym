// SPDX-License-Identifier: AGPL-3.0-only
import { RevisionConflictError } from '@plaingym/db';
import { AppError, errorResponse } from '@plaingym/shared';
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { Context, ErrorHandler } from 'hono';
import type { RequestEnvironment } from './context.js';

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof RevisionConflictError) return new AppError('conflict', 'The record changed since it was read.');
  // Validation messages can contain submitted secrets or internal schema details.
  if (error instanceof z.ZodError) return new AppError('invalid_request', 'The request is invalid.');
  if (error instanceof HTTPException) {
    switch (error.status) {
      case 400: case 422: return new AppError('invalid_request', 'The request is invalid.');
      case 401: return new AppError('unauthenticated', 'Authentication is required.');
      case 403: return new AppError('forbidden', 'Access denied.');
      case 404: return new AppError('not_found', 'Not found.');
      case 409: return new AppError('conflict', 'The record changed since it was read.');
      case 429: return new AppError('rate_limited', 'Too many requests.');
      case 503: return new AppError('unavailable', 'The service is unavailable.');
    }
  }
  return new AppError('internal', 'An unexpected error occurred.');
}

export function respondError(context: Context<RequestEnvironment>, error: unknown): Response {
  const safe = normalizeError(error);
  return context.json(errorResponse(safe, context.get('context').requestId), safe.status);
}

export const errorHandler: ErrorHandler<RequestEnvironment> = (error, context) => respondError(context, error);
