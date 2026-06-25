import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const invoiceFindFirst = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    invoice: { findFirst: invoiceFindFirst },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/share'

function req(body: object, token: string | null = 'tok') {
  const h = new Headers({ 'content-type': 'application/json' })
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

describe('POST /api/routes-b/invoices/[id]/share', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/share/route')
    const res = await POST(req({}), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/share/route')
    const res = await POST(req({}), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 422 for invalid channel', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', status: 'pending' })
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/share/route')
    const res = await POST(req({ channels: ['sms'] }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
  })

  it('returns share url on success', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', status: 'pending' })
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/share/route')
    const res = await POST(req({ channels: ['link'] }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.shareUrl).toBeTruthy()
    expect(json.expiresAt).toBeTruthy()
  })
})
