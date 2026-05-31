import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedFindUnique = vi.mocked(prisma.user.findUnique)
const mockedFindMany = vi.mocked(prisma.invoice.findMany)

const BASE_URL = 'http://localhost/api/routes-d/invoices/pending'

function makeRequest(query = '') {
  return new NextRequest(`${BASE_URL}${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-d/invoices/pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns pending invoices with default pagination', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    mockedFindMany.mockResolvedValue([
      {
        id: 'inv_1',
        invoiceNumber: 'INV-001',
        clientName: 'John Doe',
        clientEmail: 'john@example.com',
        amount: '100.00',
        currency: 'USD',
        dueDate: new Date('2026-06-01'),
        createdAt: new Date('2026-05-01'),
      },
    ] as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.data).toHaveLength(1)
    expect(data.data[0].amount).toBe(100)
    expect(data.nextCursor).toBeNull()

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'pending' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        dueDate: true,
        createdAt: true,
      },
    })
  })

  it('applies cursor pagination', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    mockedFindMany.mockResolvedValue([] as never)

    await GET(makeRequest('?cursor=inv_123'))

    expect(mockedFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'pending', id: { lt: 'inv_123' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        dueDate: true,
        createdAt: true,
      },
    })
  })

  it('respects limit parameter with max constraint', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    mockedFindMany.mockResolvedValue([] as never)

    await GET(makeRequest('?limit=100'))

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51 }) // 50 + 1 for hasNext check
    )
  })

  it('handles next cursor when more results available', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    
    // Return 21 items (limit + 1) to simulate more results
    const invoices = Array.from({ length: 21 }, (_, i) => ({
      id: `inv_${i}`,
      invoiceNumber: `INV-${i.toString().padStart(3, '0')}`,
      clientName: 'John Doe',
      clientEmail: 'john@example.com',
      amount: '100.00',
      currency: 'USD',
      dueDate: new Date('2026-06-01'),
      createdAt: new Date('2026-05-01'),
    }))
    mockedFindMany.mockResolvedValue(invoices as never)

    const res = await GET(makeRequest())
    const data = await res.json()
    
    expect(data.data).toHaveLength(20) // Should return only limit items
    expect(data.nextCursor).toBe('inv_19') // Last item's ID
  })

  it('returns 500 on database error', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    mockedFindUnique.mockResolvedValue({ id: 'user_1' } as never)
    mockedFindMany.mockRejectedValue(new Error('Database error') as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})