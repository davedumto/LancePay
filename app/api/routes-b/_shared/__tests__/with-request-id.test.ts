import { describe, it, expect } from 'vitest'
import { withRequestId, getRequestId } from '../with-request-id'

describe('_shared/with-request-id re-export', () => {
  it('exports withRequestId as a function', () => {
    expect(typeof withRequestId).toBe('function')
  })

  it('exports getRequestId as a function', () => {
    expect(typeof getRequestId).toBe('function')
  })

  it('withRequestId wraps a handler and echoes X-Request-Id in the response', async () => {
    const handler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    const wrapped = withRequestId(handler)

    const req = new Request('http://localhost/api/routes-b/test', {
      headers: { authorization: 'Bearer tok' },
    })

    const res = await wrapped(req as any)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
    expect(res.status).toBe(200)
  })

  it('accepts an incoming x-request-id UUID and echoes it back', async () => {
    const incomingId = '018f4d2a-1c3b-7000-8000-000000000abc'
    const handler = async () => new Response('{}', { status: 200 })
    const wrapped = withRequestId(handler)

    const req = new Request('http://localhost/api/routes-b/test', {
      headers: { 'x-request-id': incomingId },
    })

    const res = await wrapped(req as any)
    expect(res.headers.get('X-Request-Id')).toBe(incomingId)
  })

  it('getRequestId returns null outside a request context', () => {
    expect(getRequestId()).toBeNull()
  })

  it('getRequestId returns the request ID inside a handler invocation', async () => {
    let capturedId: string | null = null

    const handler = async () => {
      capturedId = getRequestId()
      return new Response('{}', { status: 200 })
    }

    const wrapped = withRequestId(handler)
    await wrapped(new Request('http://localhost/') as any)

    expect(capturedId).not.toBeNull()
    expect(typeof capturedId).toBe('string')
  })
})
