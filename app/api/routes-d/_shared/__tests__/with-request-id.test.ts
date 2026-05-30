import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { withRequestId } from '../with-request-id'

describe('withRequestId', () => {
  it('generates a request-id when not provided', async () => {
    const handler = withRequestId(async () => new Response('OK', { status: 200 }))
    const req = new NextRequest('http://localhost/test', { method: 'GET' })

    const res = await handler(req)
    const requestId = res.headers.get('X-Request-Id')

    expect(requestId).toBeTruthy()
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('uses a provided request-id from header', async () => {
    const providedId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const handler = withRequestId(async () => new Response('OK', { status: 200 }))
    const req = new NextRequest('http://localhost/test', {
      method: 'GET',
      headers: { 'x-request-id': providedId },
    })

    const res = await handler(req)
    const requestId = res.headers.get('X-Request-Id')

    expect(requestId).toBe(providedId)
  })

  it('echoes request-id in response header', async () => {
    const handler = withRequestId(async () => new Response('OK', { status: 200 }))
    const req = new NextRequest('http://localhost/test', { method: 'GET' })

    const res = await handler(req)

    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('handles handler errors gracefully', async () => {
    const handler = withRequestId(async () => {
      throw new Error('Test error')
    })
    const req = new NextRequest('http://localhost/test', { method: 'GET' })

    const res = await handler(req)

    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })
})
