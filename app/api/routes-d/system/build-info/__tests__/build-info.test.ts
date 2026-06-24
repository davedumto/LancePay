import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from '../route'

const BASE_URL = 'http://localhost/api/routes-d/system/build-info'

function makeGet() {
  return new NextRequest(BASE_URL)
}

describe('GET /api/routes-d/system/build-info', () => {
  it('returns build info with version and environment', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('name')
    expect(body).toHaveProperty('timestamp')
    expect(body).toHaveProperty('environment')
  })

  it('returns a valid timestamp', async () => {
    const res = await GET()
    const body = await res.json()
    const timestamp = new Date(body.timestamp as string)
    expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now())
  })
})
