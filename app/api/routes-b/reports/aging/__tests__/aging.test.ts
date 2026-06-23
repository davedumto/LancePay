import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const invoiceDelegate = prisma.invoice as unknown as { findMany: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-b/reports/aging'

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function daysAgo(days: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

describe('GET /api/routes-b/reports/aging', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns zero totals and empty items when no open invoices', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceDelegate.findMany.mockResolvedValue([])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalOutstanding).toBe(0)
    expect(body.openInvoiceCount).toBe(0)
    expect(body.items).toEqual([])
    expect(body.summary).toHaveLength(5)
  })

  it('buckets a current (not yet overdue) invoice correctly', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceDelegate.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        amount: 500,
        dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        status: 'pending',
        clientName: 'ACME',
        clientEmail: 'acme@example.com',
      },
    ])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].agingBucket).toBe('current')
    expect(body.items[0].daysOverdue).toBe(0)
  })

  it('buckets a 45-day overdue invoice into the 31-60 bucket', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceDelegate.findMany.mockResolvedValue([
      {
        id: 'inv-2',
        amount: 1000,
        dueDate: daysAgo(45),
        status: 'overdue',
        clientName: null,
        clientEmail: 'client@example.com',
      },
    ])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].agingBucket).toBe('31-60')
    expect(body.items[0].daysOverdue).toBe(45)
    const bucket = body.summary.find((s: { label: string }) => s.label === '31-60')
    expect(bucket.count).toBe(1)
    expect(bucket.totalAmount).toBe(1000)
  })

  it('buckets a 95-day overdue invoice into the 90+ bucket', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceDelegate.findMany.mockResolvedValue([
      {
        id: 'inv-3',
        amount: 2500,
        dueDate: daysAgo(95),
        status: 'overdue',
        clientName: null,
        clientEmail: 'old@example.com',
      },
    ])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].agingBucket).toBe('90+')
    expect(body.totalOutstanding).toBe(2500)
  })

  it('sums totalOutstanding across all open invoices', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    invoiceDelegate.findMany.mockResolvedValue([
      { id: 'inv-a', amount: 300, dueDate: daysAgo(10), status: 'overdue', clientName: null, clientEmail: 'a@x.com' },
      { id: 'inv-b', amount: 700, dueDate: daysAgo(50), status: 'overdue', clientName: null, clientEmail: 'b@x.com' },
    ])
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalOutstanding).toBe(1000)
    expect(body.openInvoiceCount).toBe(2)
  })
})
