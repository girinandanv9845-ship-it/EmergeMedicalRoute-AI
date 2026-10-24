import type { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export function validationError(err: ZodError, message = 'The submitted data is invalid.'): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    message,
    err.issues.map((i) => ({ path: i.path.join('.') || '(body)', message: i.message })),
  );
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} was not found.`);
