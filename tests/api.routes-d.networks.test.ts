import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'

const BASE_URL = 'http://localhost/api/routes-d/networks'

describe('GET /api/routes-d/networks', () => {
  it('returns 200 with list of supported networks', async () => {
    const { GET } = await import('@/app/api/routes-d/networks/route')
    const res = await GET(new NextRequest(BASE_URL))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.networks).toBeDefined()
    expect(Array.isArray(body.networks)).toBe(true)
    expect(body.networks.length).toBeGreaterThan(0)

    const stellar = body.networks.find((n: any) => n.id === 'stellar')
    expect(stellar).toBeDefined()
    expect(stellar.currency).toBe('USDC')
  })
})
