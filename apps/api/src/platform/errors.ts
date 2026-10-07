/** RFC 7807 problem details. `code` is a stable machine-readable identifier. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (code = 'FORBIDDEN', msg = 'You are not allowed to perform this action') => new AppError(403, code, msg);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
export const preconditionRequired = (code: string, msg: string) => new AppError(428, code, msg);
export const gone = (code: string, msg: string) => new AppError(410, code, msg);
export const badGateway = (code: string, msg: string, details?: unknown) => new AppError(502, code, msg, details);

/** Map PostgreSQL integrity errors to domain-level HTTP problems: the DB is the last line of defense. */
export function fromPgError(err: any): AppError | null {
  switch (err?.code) {
    case '23P01':
      if (String(err.constraint ?? '').includes('guide')) return conflict('GUIDE_UNAVAILABLE', 'The guide is already booked for an overlapping time');
      return conflict('INVENTORY_UNAVAILABLE', 'The requested dates are no longer available');
    case '23505':
      return conflict('DUPLICATE', 'A conflicting record already exists', { constraint: err.constraint });
    case '23503':
      return unprocessable('REFERENCE_NOT_FOUND', 'A referenced record does not exist', { constraint: err.constraint });
    case '23514':
      return unprocessable('CONSTRAINT_VIOLATION', 'The request violates a data integrity rule', { constraint: err.constraint });
    case '22P02':
      return badRequest('INVALID_INPUT', 'Malformed identifier or value');
    case 'P0001':
      return conflict('IMMUTABLE_RECORD', 'This record is append-only and cannot be modified');
    case 'P0002':
      return new AppError(500, 'LEDGER_UNBALANCED', 'Ledger transaction is not balanced');
    default:
      return null;
  }
}
