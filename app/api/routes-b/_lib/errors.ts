/**
 * Returns a structured JSON error response with an optional X-Request-Id header.
 */
export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
  requestId?: string | null,
): Response {
  const body: Record<string, unknown> = { error: message, code }
  if (details) body.details = details

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (requestId) headers['X-Request-Id'] = requestId

  return new Response(JSON.stringify(body), { status, headers })
}
