import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()
const timeEntryFindMany = vi.fn()
const timeEntryCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
    timeEntry: {
      findMany: timeEntryFindMany,
      create: timeEntryCreate,
    },
  },
}))

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/time-entries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('GET /api/routes-b/time-entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/time-entries/route')
    const response = await GET(new NextRequest('http://localhost/api/routes-b/time-entries'))

    expect(response.status).toBe(401)
    expect(timeEntryFindMany).not.toHaveBeenCalled()
  })

  it('lists the user time entries, clamps the limit, and serialises decimals', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    timeEntryFindMany.mockResolvedValue([
      {
        id: 'te_1',
        invoiceId: 'inv_1',
        description: 'Design review',
        hours: { toString: () => '2.50' },
        rateUsdc: { toString: () => '75.000000' },
        occurredOn: new Date('2026-06-20T00:00:00Z'),
        status: 'billed',
        createdAt: new Date('2026-06-20T10:00:00Z'),
        updatedAt: new Date('2026-06-20T10:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/time-entries/route')
    const response = await GET(new NextRequest('http://localhost/api/routes-b/time-entries?limit=9999'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].hours).toBe('2.50')
    expect(body.entries[0].rateUsdc).toBe('75.000000')

    expect(timeEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, where: { userId: 'user_1' } }),
    )
  })
})

describe('POST /api/routes-b/time-entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(postRequest({}))

    expect(response.status).toBe(401)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing description', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({ hours: '1', rateUsdc: '50', occurredOn: '2026-06-20' }),
    )

    expect(response.status).toBe(400)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })

  it('rejects an invalid hours value', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({
        description: 'x',
        hours: '99', // over MAX_HOURS
        rateUsdc: '50',
        occurredOn: '2026-06-20',
      }),
    )

    expect(response.status).toBe(400)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })

  it('rejects a malformed date', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({
        description: 'x',
        hours: '1',
        rateUsdc: '50',
        occurredOn: '20/06/2026',
      }),
    )

    expect(response.status).toBe(400)
  })

  it('returns 404 when invoiceId references an invoice the user does not own', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindFirst.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({
        description: 'Design',
        hours: '1',
        rateUsdc: '50',
        occurredOn: '2026-06-20',
        invoiceId: 'inv_other',
      }),
    )

    expect(response.status).toBe(404)
    expect(timeEntryCreate).not.toHaveBeenCalled()
  })

  it('creates a draft entry when no invoice is attached', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    timeEntryCreate.mockResolvedValue({
      id: 'te_new',
      invoiceId: null,
      description: 'Design review',
      hours: { toString: () => '2.50' },
      rateUsdc: { toString: () => '75' },
      occurredOn: new Date('2026-06-20T00:00:00Z'),
      status: 'draft',
      createdAt: new Date('2026-06-20T10:00:00Z'),
      updatedAt: new Date('2026-06-20T10:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-b/time-entries/route')
    const response = await POST(
      postRequest({
        description: 'Design review',
        hours: '2.5',
        rateUsdc: '75',
        occurredOn: '2026-06-20',
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toBe('te_new')
    expect(body.status).toBe('draft')
    expect(body.invoiceId).toBeNull()
    expect(timeEntryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          invoiceId: null,
          description: 'Design review',
          status: 'draft',
        }),
      }),
    )
  })
})
