import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { AsyncLocalStorage } from 'async_hooks'

type RequestContext = {
  requestId: string
}

type RouteHandler = (req: NextRequest, ...args: any[]) => unknown | Promise<unknown>

const requestContext = new AsyncLocalStorage<RequestContext>()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidRequestId(value: string | null): value is string {
  return Boolean(value && UUID_PATTERN.test(value))
}

function resolveRequestId(req?: NextRequest): string {
  const incoming = req?.headers.get('x-request-id') ?? null
  return isValidRequestId(incoming) ? incoming : randomUUID()
}

export function getRequestId(): string | null {
  return requestContext.getStore()?.requestId ?? null
}

function attachRequestId(response: Response, requestId: string): Response {
  const cloned = new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
  cloned.headers.set('X-Request-Id', requestId)
  return cloned
}

export function withRequestId<T extends RouteHandler>(handler: T) {
  return async (req: NextRequest, ...args: any[]): Promise<Response> => {
    const requestId = resolveRequestId(req)

    try {
      const result = await requestContext.run({ requestId }, () => handler(req, ...args))

      const response = result instanceof Response ? result : NextResponse.json(result ?? null)

      return attachRequestId(response, requestId)
    } catch (error) {
      const fallback = NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      return attachRequestId(fallback, requestId)
    }
  }
}
