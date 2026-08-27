import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    invoiceTaxLine: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockInvoiceId = 'inv-456'
const mockLineId = 'tl-789'
const params = { id: mockInvoiceId, lineId: mockLineId }

function makeDeleteRequest(invoiceId = mockInvoiceId, lineId = mockLineId, token = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(
    `http://localhost:3000/api/routes-b/invoices/${invoiceId}/tax-lines/${lineId}`,
    { method: 'DELETE', headers },
  )
}

describe('DELETE /api/routes-b/invoices/[id]/tax-lines/[lineId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: mockInvoiceId } as never)
    vi.mocked(prisma.invoiceTaxLine.findFirst).mockResolvedValue({ id: mockLineId } as never)
    vi.mocked(prisma.invoiceTaxLine.delete).mockResolvedValue({ id: mockLineId } as never)
  })

  it('deletes the tax line and returns 204', async () => {
    const res = await DELETE(makeDeleteRequest(), { params })
    expect(res.status).toBe(204)
    expect(prisma.invoiceTaxLine.delete).toHaveBeenCalledWith({
      where: { id: mockLineId },
    })
  })

  it('returns 401 when unauthorized', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await DELETE(makeDeleteRequest(), { params })
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 404 when invoice is not found or not owned', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await DELETE(makeDeleteRequest(), { params })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Invoice not found')
  })

  it('returns 404 when tax line does not exist on the invoice', async () => {
    vi.mocked(prisma.invoiceTaxLine.findFirst).mockResolvedValue(null)
    const res = await DELETE(makeDeleteRequest(), { params })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Tax line not found')
  })

  it('returns 400 when lineId is empty', async () => {
    const res = await DELETE(makeDeleteRequest(), {
      params: { id: mockInvoiceId, lineId: '   ' },
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Tax line ID is required')
  })

  it('returns 500 when database throws an error', async () => {
    vi.mocked(prisma.invoiceTaxLine.delete).mockRejectedValue(new Error('DB failure'))
    const res = await DELETE(makeDeleteRequest(), { params })
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Failed to remove invoice tax line')
  })
})
