/**
 * Errors that are safe to show to clients. Anything else is reported as a
 * generic 500 without internal details.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  badRequest: (message = 'The request is invalid.', extra: Record<string, unknown> = {}) =>
    new AppError(400, 'bad_request', message, extra),
  unauthorized: (message = 'Please start a session first.') => new AppError(401, 'unauthorized', message),
  forbidden: (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message),
  csrf: () => new AppError(403, 'csrf_failed', 'Your session needs to be refreshed. Please reload the page.'),
  notFound: (message = 'Not found.') => new AppError(404, 'not_found', message),
  conflict: (message: string) => new AppError(409, 'conflict', message),
  tooMany: (retryAfterSec: number, message = 'Too many requests. Please wait a moment and try again.', code = 'rate_limited') =>
    new AppError(429, code, message, { retryAfterSec }, retryAfterSec),
  unavailable: (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(503, code, message, extra),
};
