'use client'
import { NextResponse } from 'next/server'

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNPROCESSABLE_ENTITY'
  | 'INTERNAL_SERVER_ERROR'

interface ErrorEnvelope {
  error: string
  code?: ErrorCode
  details?: Record<string, unknown>
}

export function createErrorResponse(
  message: string,
  statusCode: number,
  code?: ErrorCode,
  details?: Record<string, unknown>
): NextResponse<ErrorEnvelope> {
  const body: ErrorEnvelope = {
    error: message,
    ...(code && { code }),
    ...(details && { details }),
  }
  return NextResponse.json(body, { status: statusCode })
}

export function unauthorized(message = 'Unauthorized'): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 401, 'UNAUTHORIZED')
}

export function forbidden(message = 'Forbidden'): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 403, 'FORBIDDEN')
}

export function notFound(message = 'Not found'): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 404, 'NOT_FOUND')
}

export function badRequest(message: string, details?: Record<string, unknown>): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 400, 'BAD_REQUEST', details)
}

export function conflict(message: string, details?: Record<string, unknown>): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 409, 'CONFLICT', details)
}

export function preconditionFailed(message: string, details?: Record<string, unknown>): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 412, 'PRECONDITION_FAILED', details)
}

export function unprocessableEntity(message: string, details?: Record<string, unknown>): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 422, 'UNPROCESSABLE_ENTITY', details)
}

export function internalServerError(message = 'Internal Server Error'): NextResponse<ErrorEnvelope> {
  return createErrorResponse(message, 500, 'INTERNAL_SERVER_ERROR')
}
