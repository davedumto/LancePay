import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const timeEntryFindMany = vi.fn()
const timeEntryCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    timeEntry: { findMany: timeEntryFindMany, create: timeEntryCreate },
  },
}))

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/time-entries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/routes-b/time-entries - overlap and rounding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('rejects an entry that would exceed 24 billable hours for the day with 409', async () => {
    timeEntryFindMany.mockResolvedValue([{ hours: 23 }])
    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({ description: 'Overrun', hours: '2', rateUsdc: '50', occurredOn: '2026-06-20' }),
    )
    expect(response.status).toBe(409)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })

  it('rounds hours to the nearest 15 minutes before persisting', async () => {
    timeEntryFindMany.mockResolvedValue([])
    timeEntryCreate.mockResolvedValue({
      id: 'te_r',
      invoiceId: null,
      description: 'Rounded',
      hours: { toString: () => '2.00' },
      rateUsdc: { toString: () => '50' },
      occurredOn: new Date('2026-06-20T00:00:00Z'),
      status: 'draft',
      createdAt: new Date('2026-06-20T10:00:00Z'),
      updatedAt: new Date('2026-06-20T10:00:00Z'),
    })
    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({ description: 'Rounded', hours: '2.1', rateUsdc: '50', occurredOn: '2026-06-20' }),
    )
    expect(response.status).toBe(201)
    expect(timeEntryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hours: 2 }) }),
    )
  })

  it('rejects an end-before-start style zero or negative duration', async () => {
    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({ description: 'Bad', hours: '0', rateUsdc: '50', occurredOn: '2026-06-20' }),
    )
    expect(response.status).toBe(400)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })
})
