import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PATCH } from './route'

const state = vi.hoisted(() => ({ remaining: 1, installmentStatus: 'pending', invoiceUpdates: 0, transactionCalls: 0 }))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    paymentPlan: { findFirst: vi.fn() },
    paymentPlanInstallment: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      state.transactionCalls += 1
      return callback({
        paymentPlanInstallment: {
          updateMany: vi.fn(async () => {
            if (state.installmentStatus !== 'pending') return { count: 0 }
            state.installmentStatus = 'paid'
            return { count: 1 }
          }),
          count: vi.fn(async () => state.remaining),
        },
        paymentPlan: { updateMany: vi.fn(async () => ({ count: 1 })) },
        invoice: { updateMany: vi.fn(async () => { state.invoiceUpdates += 1; return { count: 1 } }) },
      })
    }),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const planFind = vi.mocked(prisma.paymentPlan.findFirst)
const installmentFind = vi.mocked(prisma.paymentPlanInstallment.findFirst)

function call() {
  const request = new NextRequest('http://localhost/api/payment-plans/plan-1/installments/inst-1/mark-paid', {
    method: 'PATCH', headers: { authorization: 'Bearer valid' },
  })
  return PATCH(request, { params: Promise.resolve({ id: 'plan-1', installmentId: 'inst-1' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.remaining = 1
  state.installmentStatus = 'pending'
  state.invoiceUpdates = 0
  state.transactionCalls = 0
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  planFind.mockResolvedValue({ id: 'plan-1', invoiceId: 'inv-1', status: 'active' } as never)
  installmentFind.mockResolvedValue({ id: 'inst-1', status: 'pending' } as never)
})

describe('PATCH /api/payment-plans/[id]/installments/[installmentId]/mark-paid', () => {
  it('pays a non-final installment without marking the invoice paid', async () => {
    state.remaining = 1
    const response = await call()
    expect(response.status).toBe(200)
    expect((await response.json()).paymentPlan.status).toBe('active')
    expect(state.invoiceUpdates).toBe(0)
  })

  it('completes the plan and marks its invoice paid after the final installment', async () => {
    state.remaining = 0
    const response = await call()
    expect(response.status).toBe(200)
    expect((await response.json()).paymentPlan.status).toBe('completed')
    expect(state.invoiceUpdates).toBe(1)
  })

  it('rejects an installment that is already paid', async () => {
    installmentFind.mockResolvedValue({ id: 'inst-1', status: 'paid' } as never)
    const response = await call()
    expect(response.status).toBe(409)
    expect(state.transactionCalls).toBe(0)
  })
})