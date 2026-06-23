import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
    invoice: { findMany: vi.fn() },
    expense: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const txDelegate = prisma.transaction as unknown as { findMany: ReturnType<typeof vi.fn> }
const invoiceDelegate = prisma.invoice as unknown as { findMany: ReturnType<typeof vi.fn> }
const expenseDelegate = prisma.expense as unknown as { findMany: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-b/reports/cash-flow'

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-b/reports/cash-flow', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns forecast with zero averages when no history', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    txDelegate.findMany.mockResolvedValue([])
    invoiceDelegate.findMany.mockResolvedValue([])
    expenseDelegate.findMany.mockResolvedValue([])

    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.averageMonthlyIncome).toBe(0)
    expect(body.averageMonthlyExpenses).toBe(0)
    expect(body.averageNetCashFlow).toBe(0)
    expect(body.forecast).toHaveLength(3)
    expect(body.currency).toBe('USDC')
  })

  it('includes expectedInvoicePayments for pending invoices due in the forecast window', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    txDelegate.findMany.mockResolvedValue([])
    expenseDelegate.findMany.mockResolvedValue([])

    const nextMonth = new Date()
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    nextMonth.setUTCDate(15)

    invoiceDelegate.findMany.mockResolvedValue([
      { amount: 1200, dueDate: nextMonth.toISOString(), status: 'pending' },
    ])

    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    const monthWithInvoice = body.forecast.find(
      (f: { year: number; month: number; expectedInvoicePayments: number }) =>
        f.year === nextMonth.getUTCFullYear() && f.month === nextMonth.getUTCMonth() + 1,
    )
    expect(monthWithInvoice?.expectedInvoicePayments).toBe(1200)
  })

  it('calculates averages from historical transactions and expenses', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    txDelegate.findMany.mockResolvedValue([{ amount: 600 }, { amount: 600 }])
    expenseDelegate.findMany.mockResolvedValue([{ amount: 300 }])
    invoiceDelegate.findMany.mockResolvedValue([])

    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    // 1200 income / 6 months = 200, 300 expenses / 6 months = 50
    expect(body.averageMonthlyIncome).toBe(200)
    expect(body.averageMonthlyExpenses).toBe(50)
    expect(body.averageNetCashFlow).toBe(150)
  })
})
