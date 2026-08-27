import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const paymentReminderFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    paymentReminder: { findMany: paymentReminderFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/invoices/inv-1/reminders'

function req(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { headers: h })
}

const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

describe('GET /api/routes-b/invoices/[id]/reminders (#1117)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    const { GET } = await import('./route')
    const res = await GET(req(null), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(404)
  })

  it('returns empty reminders array when none sent', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    paymentReminderFindMany.mockResolvedValue([])

    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.reminders).toEqual([])
    expect(json.invoiceId).toBe('inv-1')
  })

  it('returns reminder history for the invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' })
    paymentReminderFindMany.mockResolvedValue([
      {
        id: 'rem-1',
        reminderType: 'manual',
        daysOffset: null,
        sentAt: new Date('2026-01-15T10:00:00Z'),
        createdAt: new Date('2026-01-15T10:00:00Z'),
      },
      {
        id: 'rem-2',
        reminderType: 'before_due',
        daysOffset: 3,
        sentAt: new Date('2026-01-10T08:00:00Z'),
        createdAt: new Date('2026-01-10T08:00:00Z'),
      },
    ])

    const { GET } = await import('./route')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.reminders).toHaveLength(2)
    expect(json.reminders[0].reminderType).toBe('manual')
    expect(paymentReminderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { invoiceId: 'inv-1' } }),
    )
  })
})
