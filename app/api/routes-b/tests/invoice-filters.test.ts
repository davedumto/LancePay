import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn(() => 'INV-1001') }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET as listInvoices } from '../invoices/route'

describe('GET /invoices multi-field filters', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1' } as any)
    vi.mocked(prisma.invoice.count).mockResolvedValue(0)
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([] as any)
  })

  it('applies single filter', async () => {
    await listInvoices(new NextRequest('http://localhost/api/routes-b/invoices?number=INV-1', { headers: { authorization: 'Bearer token' } }))
    expect(vi.mocked(prisma.invoice.findMany).mock.calls[0][0].where.invoiceNumber).toEqual({ contains: 'INV-1', mode: 'insensitive' })
  })

  it('applies combined filters with AND semantics', async () => {
    await listInvoices(new NextRequest('http://localhost/api/routes-b/invoices?number=INV&client=acme&minAmount=10&maxAmount=99&currency=usd', { headers: { authorization: 'Bearer token' } }))
    const where = vi.mocked(prisma.invoice.findMany).mock.calls[0][0].where
    expect(where.invoiceNumber).toBeTruthy()
    expect(where.clientName).toBeTruthy()
    expect(where.amount).toEqual({ gte: 10, lte: 99 })
    expect(where.currency).toBe('USD')
  })

  it('rejects invalid amount', async () => {
    const res = await listInvoices(new NextRequest('http://localhost/api/routes-b/invoices?minAmount=-1', { headers: { authorization: 'Bearer token' } }))
    expect(res.status).toBe(400)
  })
})
