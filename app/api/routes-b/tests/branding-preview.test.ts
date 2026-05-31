import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { brandingSettings: { upsert: vi.fn() } } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../branding/preview/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUpsert = vi.mocked(prisma.brandingSettings.upsert)

const URL = 'http://localhost/api/routes-b/branding/preview'

function makeRequest(body: unknown, auth = 'Bearer token') {
  return new NextRequest(URL, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-b/branding/preview', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUpsert.mockResolvedValue(null as never)
  })

  it('returns 200 and renders safe HTML for valid branding', async () => {
    const res = await POST(
      makeRequest({
        primaryColor: '#112233',
        accentColor: '#00ff00',
        footerText: '<script>alert(1)</script>',
        logoUrl: 'https://example.com/logo.png',
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Invoice Preview')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('src="https://example.com/logo.png"')
    expect(mockedUpsert).not.toHaveBeenCalled()
  })

  it('returns 422 for invalid branding and does not write to the database', async () => {
    const res = await POST(makeRequest({ primaryColor: 'not-a-hex' }))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toBeDefined()
    expect(json.error.fields?.primaryColor).toBe('Must be a valid 6-digit hex color')
    expect(mockedUpsert).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthorized', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makeRequest({ primaryColor: '#112233' }))
    expect(res.status).toBe(401)
  })
})
