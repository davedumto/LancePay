import { NextRequest } from 'next/server'
import crypto from 'crypto'

type RouteHandler = (request: NextRequest) => Promise<Response>

/**
 * Wraps a route handler to inject an X-Request-Id header on every response.
 * Uses the incoming X-Request-Id header if present, otherwise generates a new UUID.
 */
export function withRequestId(handler: RouteHandler): RouteHandler {
  return async (request: NextRequest) => {
    const requestId =
      request.headers.get('x-request-id') ?? crypto.randomUUID()

    const response = await handler(request)

    const patched = new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
    patched.headers.set('X-Request-Id', requestId)
    return patched
  }
}
