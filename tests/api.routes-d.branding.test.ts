import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const brandingFindUnique = vi.fn()
const brandingUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    brandingSettings: { findUnique: brandingFindUnique, upsert: brandingUpsert },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/branding'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-d/branding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/branding/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns null branding when none exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    brandingFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/branding/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ branding: null })
  })

  it('returns branding settings when they exist', async () => {
    const branding = {
      id: 'b1',
      userId: 'user_1',
      logoUrl: 'https://example.com/logo.png',
      primaryColor: '#6366f1',
      footerText: 'Thanks!',
      signatureUrl: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    }
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    brandingFindUnique.mockResolvedValue(branding)
    const { GET } = await import('@/app/api/routes-d/branding/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.branding.primaryColor).toBe('#6366f1')
  })
})

describe('PATCH /api/routes-d/branding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', {}))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid hex color', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', { primaryColor: 'red' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/primaryColor/)
  })

  it('returns 400 for non-https logoUrl', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', { logoUrl: 'http://example.com/logo.png' }))
    expect(res.status).toBe(400)
  })

  it('returns 200 with unchanged branding on empty body', async () => {
    const branding = { id: 'b1', userId: 'user_1', primaryColor: '#000000' }
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    brandingUpsert.mockResolvedValue(branding)
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', {}))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ branding })
  })

  it('upserts with valid data', async () => {
    const branding = { id: 'b1', userId: 'user_1', primaryColor: '#6366f1', footerText: 'Thanks!' }
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    brandingUpsert.mockResolvedValue(branding)
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', { primaryColor: '#6366f1', footerText: 'Thanks!' }))
    expect(res.status).toBe(200)
    expect(brandingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        update: expect.objectContaining({ primaryColor: '#6366f1', footerText: 'Thanks!' }),
      }),
    )
  })

  it('allows signatureUrl: null to clear the field', async () => {
    const branding = { id: 'b1', userId: 'user_1', signatureUrl: null }
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    brandingUpsert.mockResolvedValue(branding)
    const { PATCH } = await import('@/app/api/routes-d/branding/route')
    const res = await PATCH(makeRequest('PATCH', { signatureUrl: null }))
    expect(res.status).toBe(200)
  })
})
