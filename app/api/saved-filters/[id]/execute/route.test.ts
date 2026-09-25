import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savedFilter: { findFirst: vi.fn() },
    invoice: { count: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const storedDefinition = {
  match: 'any',
  conditions: [
    { field: 'status', operator: 'eq', value: 'overdue' },
    { field: 'dueDate', operator: 'lt', value: '2026-09-01' },
  ],
}

const invoiceRow = {
  id: 'inv-1',
  invoiceNumber: 'INV-001',
  clientEmail: 'client@acme.io',
  clientName: 'Acme',
  description: 'Logo design',
  amount: new Prisma.Decimal('1250.50'),
  currency: 'USD',
  status: 'overdue',
  dueDate: new Date('2026-08-15T00:00:00Z'),
  paidAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
}

function makeRequest(query = '', headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(`http://localhost/api/saved-filters/filter-1/execute${query}`, { method: 'POST', headers })
}

function ctx(id = 'filter-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.savedFilter.findFirst).mockResolvedValue({
    id: 'filter-1',
    name: 'Late',
    filters: storedDefinition,
  } as never)
  vi.mocked(prisma.invoice.count).mockResolvedValue(1)
  vi.mocked(prisma.invoice.findMany).mockResolvedValue([invoiceRow] as never)
})

describe('POST /api/saved-filters/[id]/execute', () => {
  it('runs the stored filter against the caller\'s invoices', async () => {
    const res = await POST(makeRequest(), ctx())

    expect(res.status).toBe(200)
    const expectedWhere = {
      AND: [
        { userId: 'user-1' },
        { OR: [{ status: { equals: 'overdue' } }, { dueDate: { lt: new Date('2026-09-01') } }] },
      ],
    }
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: expectedWhere })
    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 25,
      select: expect.any(Object),
    })

    const body = await res.json()
    expect(body.savedFilter).toEqual({ id: 'filter-1', name: 'Late' })
    expect(body.invoices).toEqual([
      {
        ...invoiceRow,
        amount: 1250.5,
        dueDate: '2026-08-15T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ])
    expect(body.pagination).toEqual({ page: 1, pageSize: 25, totalRows: 1, totalPages: 1 })
  })

  it('looks the filter up by id and owner in a single scoped query', async () => {
    await POST(makeRequest(), ctx('filter-1'))
    expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
      where: { id: 'filter-1', userId: 'user-1', entityType: 'invoice' },
      select: { id: true, name: true, filters: true },
    })
  })

  it('applies pagination', async () => {
    vi.mocked(prisma.invoice.count).mockResolvedValue(45)

    const res = await POST(makeRequest('?page=3&pageSize=20'), ctx())

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }))
    expect((await res.json()).pagination).toEqual({ page: 3, pageSize: 20, totalRows: 45, totalPages: 3 })
  })

  it('enforces the maximum page size and sane bounds', async () => {
    await POST(makeRequest('?page=-4&pageSize=5000'), ctx())
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }))

    await POST(makeRequest('?page=abc&pageSize=0'), ctx())
    expect(prisma.invoice.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, take: 25 }))
  })

  it('returns 404 for a nonexistent filter', async () => {
    vi.mocked(prisma.savedFilter.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx('missing'))
    expect(res.status).toBe(404)
    expect(prisma.invoice.findMany).not.toHaveBeenCalled()
  })

  it('returns the same 404 for another user\'s filter', async () => {
    vi.mocked(prisma.savedFilter.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx('other-users-filter'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Saved filter not found' })
  })

  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('', {}), ctx())
    expect(res.status).toBe(401)
    expect(prisma.savedFilter.findFirst).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(401)
  })

  it('refuses to run a stored definition that no longer validates', async () => {
    const corrupted = [
      null,
      'SELECT * FROM "Invoice"',
      { status: 'pending' },
      { conditions: [{ field: 'userId', operator: 'eq', value: 'user-2' }] },
      { conditions: [{ field: 'status', operator: 'equals', value: 'paid' }] },
      { conditions: [{ field: 'status', operator: 'eq', value: { not: 'paid' } }] },
      { conditions: [{ field: 'status', operator: 'eq', value: 'paid' }], OR: [{ userId: 'user-2' }] },
    ]
    for (const filters of corrupted) {
      vi.mocked(prisma.savedFilter.findFirst).mockResolvedValue({ id: 'filter-1', name: 'Bad', filters } as never)
      const res = await POST(makeRequest(), ctx())
      expect(res.status).toBe(422)
      expect((await res.json()).error).toBe('Saved filter definition is no longer valid')
    }
    expect(prisma.invoice.findMany).not.toHaveBeenCalled()
    expect(prisma.invoice.count).not.toHaveBeenCalled()
  })

  it('keeps an "any" filter inside the owner scope', async () => {
    vi.mocked(prisma.savedFilter.findFirst).mockResolvedValue({
      id: 'filter-1',
      name: 'Wide',
      filters: { match: 'any', conditions: [{ field: 'amount', operator: 'gte', value: 0 }] },
    } as never)

    await POST(makeRequest(), ctx())

    const where = vi.mocked(prisma.invoice.findMany).mock.calls[0][0]!.where
    expect(where).toEqual({ AND: [{ userId: 'user-1' }, { OR: [{ amount: { gte: 0 } }] }] })
  })

  it('returns a generic 500 on database errors', async () => {
    vi.mocked(prisma.invoice.findMany).mockRejectedValue(new Error('invalid input syntax for type numeric'))
    const res = await POST(makeRequest(), ctx())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('numeric')
  })
})
