import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const invoiceUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    invoice: { findFirst: invoiceFindFirst, update: invoiceUpdate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/cancel'

function req(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h })
}

describe('POST /api/routes-b/invoices/[id]/cancel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/cancel/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/cancel/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 400 when invoice is not pending', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', status: 'paid' })
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/cancel/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Only pending invoices can be cancelled')
  })

  it('returns 200 and cancels invoice on success', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', status: 'pending' })
    const mockDate = new Date()
    invoiceUpdate.mockResolvedValue({ id: 'inv-1', status: 'cancelled', cancelledAt: mockDate })
    
    const { POST } = await import('@/app/api/routes-b/invoices/[id]/cancel/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'inv-1' }) })
    
    expect(res.status).toBe(200)
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: {
        status: 'cancelled',
        cancelledAt: expect.any(Date),
      }
    })
    
    const json = await res.json()
    expect(json.id).toBe('inv-1')
    expect(json.status).toBe('cancelled')
    expect(json.cancelledAt).toBe(mockDate.toISOString())
  })
})
