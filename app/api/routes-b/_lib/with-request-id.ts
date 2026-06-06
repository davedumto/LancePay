import { AsyncLocalStorage } from 'async_hooks'
import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { ROUTES_B_SCHEMA_VERSION, isSchemaCompatible } from './schema-version'

type RequestContext = {
  requestId: string
}

type RouteHandler = (req: NextRequest, ...args: any[]) => unknown | Promise<unknown>

const requestContext = new AsyncLocalStorage<RequestContext>()
const LOGGER_PATCHED = Symbol.for('routes-b.logger.request-id-patched')

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function generateUuidV7(): string {
  const bytes = randomBytes(16)
  const timestamp = Date.now()

  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff
  bytes[5] = timestamp & 0xff

  bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isUuid(value: string | null): value is string {
  return Boolean(value && UUID_PATTERN.test(value))
}

function resolveRequestId(req?: NextRequest) {
  const incoming = req?.headers.get('x-request-id') ?? null
  return isUuid(incoming) ? incoming : generateUuidV7()
}

export function getRequestId(): string | null {
  return requestContext.getStore()?.requestId ?? null
}

function patchLogger() {
  const target = logger as any
  if (target[LOGGER_PATCHED]) return

  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    const original = target[level]
    if (typeof original !== 'function') continue

    target[level] = function (...args: any[]) {
      const requestId = getRequestId()
      if (requestId) {
        const first = args[0]
        if (first && typeof first === 'object' && !(first instanceof Error)) {
          args[0] = { requestId, ...first }
        } else {
          args.unshift({ requestId })
        }
      }
      return original.apply(this, args)
    }
  }

  target[LOGGER_PATCHED] = true
}

function attachRequestId(response: Response, requestId: string): Response {
  // clone safely to avoid mutating immutable responses
  const cloned = new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })

  cloned.headers.set('X-Request-Id', requestId)
  cloned.headers.set('X-Routes-B-Schema', ROUTES_B_SCHEMA_VERSION)
  return cloned
}

patchLogger()

export function withRequestId<T extends RouteHandler>(handler: T) {
  return async (req: NextRequest, ...args: any[]): Promise<Response> => {
    const requestId = resolveRequestId(req)

    const acceptSchema = req.headers.get('x-accept-schema')
    if (acceptSchema && !isSchemaCompatible(acceptSchema)) {
      const response = NextResponse.json({ error: 'Incompatible schema version' }, { status: 406 })
      return attachRequestId(response, requestId)
    }

    try {
      const result = await requestContext.run({ requestId }, () =>
        handler(req, ...args),
      )

      const response =
        result instanceof Response
          ? result
          : NextResponse.json(result ?? null)

      return attachRequestId(response, requestId)
    } catch (error) {
      logger.error({ err: error }, 'Unhandled route error')

      const fallback = NextResponse.json(
        { error: 'Internal server error', requestId },
        { status: 500 },
      )

      return attachRequestId(fallback, requestId)
    }
  }
}