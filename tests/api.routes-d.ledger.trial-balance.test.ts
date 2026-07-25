import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const journalLineGroupBy = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    journalLine: { groupBy: journalLineGroupBy },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/ledger/trial-balance'

function makeRequest(query = '', headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(`${BASE_URL}${query}`, { method: 'GET', headers })
}

async function importRoute() {
  return import('@/app/api/routes-d/ledger/trial-balance/route')
}

describe('GET /api/routes-d/ledger/trial-balance (#1202)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeRequest('', {}))

    expect(response.status).toBe(401)
    expect(journalLineGroupBy).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
  })

  it('returns 401 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
  })

  it('returns a balanced trial balance grouped by account', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalLineGroupBy.mockResolvedValue([
      { account: 'cash', _sum: { debit: '150', credit: '50' } },
      { account: 'revenue', _sum: { debit: '0', credit: '100' } },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.accounts).toEqual([
      { account: 'cash', debit: 150, credit: 50, balance: 100 },
      { account: 'revenue', debit: 0, credit: 100, balance: -100 },
    ])
    expect(body.totals).toEqual({ debit: 150, credit: 150, balanced: true })
    expect(body.asOf).toBeNull()
    expect(journalLineGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['account'],
        where: { entry: { userId: 'user_1', status: 'posted' } },
      }),
    )
  })

  it('flags an unbalanced ledger', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalLineGroupBy.mockResolvedValue([
      { account: 'cash', _sum: { debit: '100', credit: '0' } },
      { account: 'revenue', _sum: { debit: '0', credit: '90' } },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.totals).toEqual({ debit: 100, credit: 90, balanced: false })
  })

  it('applies the asOf filter when provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalLineGroupBy.mockResolvedValue([])

    const { GET } = await importRoute()
    const response = await GET(makeRequest('?asOf=2026-06-30T00:00:00.000Z'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.asOf).toBe('2026-06-30T00:00:00.000Z')
    expect(journalLineGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entry: {
            userId: 'user_1',
            status: 'posted',
            entryDate: { lte: new Date('2026-06-30T00:00:00.000Z') },
          },
        },
      }),
    )
  })

  it('returns 400 for an invalid asOf date', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await importRoute()
    const response = await GET(makeRequest('?asOf=not-a-date'))

    expect(response.status).toBe(400)
    expect(journalLineGroupBy).not.toHaveBeenCalled()
  })

  it('returns an empty report when there are no journal lines', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalLineGroupBy.mockResolvedValue([])

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.accounts).toEqual([])
    expect(body.totals).toEqual({ debit: 0, credit: 0, balanced: true })
  })

  it('returns 500 when the aggregation fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalLineGroupBy.mockRejectedValue(new Error('db down'))

    const { GET } = await importRoute()
    const response = await GET(makeRequest())

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
