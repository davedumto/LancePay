import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const paymentPlanFindUnique = vi.fn()
const paymentPlanCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    paymentPlan: { findUnique: paymentPlanFindUnique, create: paymentPlanCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/schedule'

function req(method: string, body?: unknown, token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  if (body !== undefined) h.set('content-type', 'application/json')
  return new NextRequest(URL, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

describe('GET /api/routes-b/invoices/[id]/schedule (#1116)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('GET', undefined, null), ctx)
    expect(res.status).toBe(401)
  })

  it('returns null schedule when none exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    paymentPlanFindUnique.mockResolvedValue(null)

    const { GET } = await import('./route')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.schedule).toBeNull()
    expect(json.invoiceId).toBe('inv-1')
  })

  it('returns payment schedule with installments', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    paymentPlanFindUnique.mockResolvedValue({
      id: 'plan-1', invoiceId: 'inv-1', totalAmount: 600, currency: 'USD',
      installmentCount: 3, frequency: 'monthly', status: 'active',
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
      installments: [
        { id: 'inst-1', sequence: 1, amount: 200, dueDate: new Date('2026-02-01'), status: 'pending', paidAt: null },
      ],
    })

    const { GET } = await import('./route')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.schedule.installmentCount).toBe(3)
    expect(json.schedule.installments).toHaveLength(1)
  })
})

describe('POST /api/routes-b/invoices/[id]/schedule (#1116)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 for invalid installmentCount', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('./route')
    const res = await POST(req('POST', { installmentCount: 1 }), ctx)
    expect(res.status).toBe(400)
  })

  it('returns 409 when schedule already exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', amount: 600, currency: 'USD' })
    paymentPlanFindUnique.mockResolvedValue({ id: 'plan-1' })

    const { POST } = await import('./route')
    const res = await POST(req('POST', { installmentCount: 3 }), ctx)
    expect(res.status).toBe(409)
  })

  it('creates payment schedule successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1', amount: 600, currency: 'USD' })
    paymentPlanFindUnique.mockResolvedValue(null)
    paymentPlanCreate.mockResolvedValue({
      id: 'plan-1', invoiceId: 'inv-1', totalAmount: 600, currency: 'USD',
      installmentCount: 3, frequency: 'monthly', status: 'active',
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
      installments: [
        { id: 'inst-1', sequence: 1, amount: 200, dueDate: new Date('2026-02-01'), status: 'pending', paidAt: null },
        { id: 'inst-2', sequence: 2, amount: 200, dueDate: new Date('2026-03-01'), status: 'pending', paidAt: null },
        { id: 'inst-3', sequence: 3, amount: 200, dueDate: new Date('2026-04-01'), status: 'pending', paidAt: null },
      ],
    })

    const { POST } = await import('./route')
    const res = await POST(req('POST', { installmentCount: 3, frequency: 'monthly' }), ctx)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.schedule.installments).toHaveLength(3)
    expect(json.invoiceId).toBe('inv-1')
  })
})
