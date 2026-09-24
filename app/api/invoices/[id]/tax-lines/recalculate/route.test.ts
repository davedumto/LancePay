import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    taxRate: { findFirst: vi.fn() },
    invoiceTaxLine: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const userId = 'user-1'
const privyId = 'privy-1'
const invoiceId = 'inv-1'
const params = { id: invoiceId }
const invoiceDate = new Date('2026-01-15T00:00:00Z')

function makePost(token = 'valid') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/invoices/${invoiceId}/tax-lines/recalculate`, {
    method: 'POST',
    headers,
  })
}

describe('Invoice tax-lines recalculate API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: privyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: userId } as never)
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: invoiceId,
      amount: 1000,
      status: 'pending',
      createdAt: invoiceDate,
    } as never)
    vi.mocked(prisma.invoiceTaxLine.findMany).mockResolvedValue([
      { id: 'tl-1', invoiceId, name: 'VAT', rate: 0.1, amount: 100, taxRateId: null },
    ] as never)
    // Effective rate on the invoice date is 20%.
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue({
      id: 'tr-effective',
      name: 'VAT',
      rate: 0.2,
    } as never)
    vi.mocked(prisma.invoiceTaxLine.deleteMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.invoiceTaxLine.create).mockImplementation(async ({ data }: { data: unknown }) => ({
      id: 'tl-new',
      ...(data as object),
    } as never))
    // Execute the batched operations so create() results flow through.
    vi.mocked(prisma.$transaction).mockImplementation(async (ops: unknown) =>
      Promise.all(ops as Promise<unknown>[]),
    )
  })

  it('recomputes tax lines using the effective-dated rate (happy path)', async () => {
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.taxLines).toHaveLength(1)
    // 20% of 1000 = 200.
    expect(data.taxLines[0].amount).toBe(200)
    expect(data.taxLines[0].rate).toBe(0.2)
    expect(data.taxLines[0].taxRateId).toBe('tr-effective')
  })

  it('resolves the rate against the invoice date, not the current date', async () => {
    await POST(makePost(), { params })
    const call = vi.mocked(prisma.taxRate.findFirst).mock.calls[0][0] as {
      where: { effectiveFrom: { lte: Date } }
    }
    expect(call.where.effectiveFrom.lte).toEqual(invoiceDate)
  })

  it('replaces lines atomically (deleteMany + creates in one transaction)', async () => {
    await POST(makePost(), { params })
    expect(prisma.$transaction).toHaveBeenCalledOnce()
    const ops = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown[]
    // one deleteMany + one create.
    expect(ops).toHaveLength(2)
    expect(prisma.invoiceTaxLine.deleteMany).toHaveBeenCalledWith({ where: { invoiceId } })
  })

  it('rejects recalculation on a paid invoice', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: invoiceId,
      amount: 1000,
      status: 'paid',
      createdAt: invoiceDate,
    } as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('paid invoice')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('falls back to the existing line rate when no effective rate exists', async () => {
    vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(null as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    // Existing 0.1 retained: 10% of 1000 = 100.
    expect(data.taxLines[0].rate).toBe(0.1)
    expect(data.taxLines[0].amount).toBe(100)
  })

  it('returns 404 when the invoice is not found', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthorized', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB'))
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(500)
  })
})
