import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../invoices/bulk-status/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

function makeReq(body: any) {
  return new NextRequest('http://localhost/api/routes-b/invoices/bulk-status', {
    method: 'POST',
    headers: { 
      'authorization': 'Bearer valid-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
  })
}

describe('Bulk Status Update API', () => {
  const mockUser = { id: 'user-1', privyId: 'privy-1', role: 'user' }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  })

  it('updates multiple invoices successfully', async () => {
    const ids = ['inv-1', 'inv-2']
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { id: 'inv-1' },
      { id: 'inv-2' },
    ] as any)
    vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 2 } as any)

    const res = await POST(makeReq({ ids, status: 'paid' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.results).toHaveLength(2)
    expect(body.results.every((r: any) => r.ok)).toBe(true)
    
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ids }, userId: 'user-1' },
      data: { status: 'paid' }
    })
  })

  it('handles mixed ownership (partial success)', async () => {
    const ids = ['inv-own', 'inv-other']
    // Only return the one that belongs to the user
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([
      { id: 'inv-own' },
    ] as any)
    vi.mocked(prisma.invoice.updateMany).mockResolvedValue({ count: 1 } as any)

    const res = await POST(makeReq({ ids, status: 'cancelled' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { id: 'inv-own', ok: true },
      { id: 'inv-other', ok: false, error: 'Invoice not found or access denied' }
    ])
    
    // Only the owned ID should be in the updateMany call
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['inv-own'] }, userId: 'user-1' },
      data: { status: 'cancelled' }
    })
  })

  it('returns 400 for oversized arrays', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `inv-${i}`)
    const res = await POST(makeReq({ ids, status: 'paid' }))
    
    expect(res.status).toBe(400)
  })

  it('returns 400 for empty arrays', async () => {
    const res = await POST(makeReq({ ids: [], status: 'paid' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid status', async () => {
    const res = await POST(makeReq({ ids: ['inv-1'], status: 'pending' }))
    expect(res.status).toBe(400)
  })

  it('returns empty results if no IDs are owned', async () => {
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
    
    const res = await POST(makeReq({ ids: ['inv-1'], status: 'paid' }))
    const body = await res.json()
    
    expect(body.results[0].ok).toBe(false)
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled()
  })
})
