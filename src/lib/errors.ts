/**
 * Spec ErrorResponse envelope. Field semantics from the four documented samples:
 * status = HTTP code as a string, traceId = UUID, details = constant sentence, message = free text.
 */
import { randomUUID } from 'node:crypto'

export const ERROR_DETAILS = 'Please refer to the API documentation or contact Shaype for more info with the traceId.'

export interface ErrorResponse {
  message: string
  details: string
  status: string
  traceId: string
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Optional non-ErrorResponse body for the handful of ops whose 4xx declares a domain schema. */
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const badRequest = (message: string) => new ApiError(400, message)
export const forbidden = (message = 'FORBIDDEN: Access denied') => new ApiError(403, message)
export const notFound = (message: string) => new ApiError(404, message)
export const conflict = (message: string) => new ApiError(409, message)
export const unprocessable = (message: string) => new ApiError(422, message)

export function errorBody(status: number, message: string, traceId = randomUUID()): ErrorResponse {
  return { message, details: ERROR_DETAILS, status: String(status), traceId }
}
