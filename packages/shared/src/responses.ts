// SPDX-License-Identifier: AGPL-3.0-only
export const errorStatus = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof errorStatus;
export type ErrorDetails = Readonly<Record<string, readonly string[]>>;

export class AppError extends Error {
  readonly status: (typeof errorStatus)[ErrorCode];
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = errorStatus[code];
  }
}

export interface DataResponse<T> {
  data: T;
}
export interface ErrorResponse {
  error: { code: ErrorCode; message: string; details?: ErrorDetails };
  requestId: string;
}

export function dataResponse<T>(data: T): DataResponse<T> {
  return { data };
}

export function errorResponse(error: unknown, requestId: string): ErrorResponse {
  const known = error instanceof AppError;
  return {
    error: {
      code: known ? error.code : 'internal',
      message: known ? error.message : 'An unexpected error occurred.',
      ...(known && error.details ? { details: error.details } : {}),
    },
    requestId,
  };
}
