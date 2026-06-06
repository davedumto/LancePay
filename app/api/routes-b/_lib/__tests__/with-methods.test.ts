import { describe, it, expect } from 'vitest'
import { withMethods } from '../with-methods'

describe('with-methods', () => {
  it('returns the handler result for allowed methods', async () => {
    const handler = withMethods({
      GET: async () => new Response('GET response', { status: 200 }),
      POST: async () => new Response('POST response', { status: 201 }),
    })

    const getResponse = await handler.GET()
    expect(getResponse.status).toBe(200)
    expect(await getResponse.text()).toBe('GET response')

    const postResponse = await handler.POST()
    expect(postResponse.status).toBe(201)
    expect(await postResponse.text()).toBe('POST response')
  })

  it('returns 405 with Allow header for unsupported methods', async () => {
    const handler = withMethods({
      GET: async () => new Response('GET response', { status: 200 }),
      POST: async () => new Response('POST response', { status: 201 }),
    })

    const response = await handler.DELETE()
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, POST')
    expect(response.headers.get('Content-Type')).toBe('application/json')
    const body = await response.json()
    expect(body).toEqual({ error: 'Method not allowed' })
  })

  it('includes all defined methods in Allow header', async () => {
    const handler = withMethods({
      GET: async () => new Response('OK'),
      POST: async () => new Response('OK'),
      PUT: async () => new Response('OK'),
      PATCH: async () => new Response('OK'),
      DELETE: async () => new Response('OK'),
    })

    const response = await handler.OPTIONS()
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, POST, PUT, PATCH, DELETE')
  })
})