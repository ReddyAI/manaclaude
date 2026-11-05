/** An error with an HTTP status and a message that is safe to show the user. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new ApiError(400, code, message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);
