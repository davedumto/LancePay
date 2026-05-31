import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: {
      findMany: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET as GETPaid } from '../paid/route'
import { GET as GETPending } from '../pending/route'
import { GET as GETCancelled } from '../cancelled/route'
import { GET as GETArchived } from '../archived/route'
import { GET as GETOverdue } from '../overdue/route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const mockInvoiceFindMany = vi.mocked(prisma.invoice.findMany)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }
const baseInvoice = {
  id: 'inv-1',
  userId: 'user-1',
  createdAt: new Date(),
  amount: '100',
  invoiceNumber: 'INV-1',
}

describe('Status-specific invoice endpoints pagination', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
  })

  const endpoints = [
    { name: 'paid', handler: GETPaid },
    { name: 'pending', handler: GETPending },
    { name: 'cancelled', handler: GETCancelled },
    { name: 'archived', handler: GETArchived },
    { name: 'overdue', handler: GETOverdue },
  ]

  for (const { name, handler } of endpoints) {
    it(`returns paginated results for ${name} endpoint`, async () => {
      const invoices = Array.from({ length: 6 }, (_, i) => ({
        ...baseInvoice,
        id: `inv-${i}`,
        createdAt: new Date(Date.now() - i * 1000),
        ...(name === 'overdue' ? { dueDate: new Date(Date.now() - 10000) } : {}),
      }))
      mockInvoiceFindMany.mockResolvedValue(invoices as never)

      const req = new NextRequest(`http://localhost/api/routes-b/invoices/${name}?limit=5`, {
        headers: { authorization: 'Bearer tok' },
      })
      const res = await handler(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.invoices).toHaveLength(5)
      expect(body.nextCursor).not.toBeNull()
      
      expect(mockInvoiceFindMany).toHaveBeenCalledWith(expect.objectContaining({
        take: 6,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }))
    })

    it(`returns null nextCursor for ${name} when no more results`, async () => {
      const invoices = Array.from({ length: 5 }, (_, i) => ({
        ...baseInvoice,
        id: `inv-${i}`,
        createdAt: new Date(Date.now() - i * 1000),
        ...(name === 'overdue' ? { dueDate: new Date(Date.now() - 10000) } : {}),
      }))
      mockInvoiceFindMany.mockResolvedValue(invoices as never)

      const req = new NextRequest(`http://localhost/api/routes-b/invoices/${name}?limit=5`, {
        headers: { authorization: 'Bearer tok' },
      })
      const res = await handler(req)
      const body = await res.json()

      expect(body.invoices).toHaveLength(5)
      expect(body.nextCursor).toBeNull()
    })
  }
})
