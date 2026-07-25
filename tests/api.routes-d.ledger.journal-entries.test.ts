import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const journalEntryFindMany = vi.fn()
const journalEntryCreate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    journalEntry: { findMany: journalEntryFindMany, create: journalEntryCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/ledger/journal-entries'

function makeGet(query = '', headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(`${BASE_URL}${query}`, { method: 'GET', headers })
}

function makePost(body: unknown, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function importRoute() {
  return import('@/app/api/routes-d/ledger/journal-entries/route')
}

const balancedLines = [
  { account: 'cash', debit: 100 },
  { account: 'revenue', credit: 100 },
]

describe('GET /api/routes-d/ledger/journal-entries (#1203)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeGet('', {}))

    expect(response.status).toBe(401)
    expect(journalEntryFindMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeGet())

    expect(response.status).toBe(401)
  })

  it('lists entries for the user with the default limit', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalEntryFindMany.mockResolvedValue([
      {
        id: 'je_1',
        entryDate: new Date('2026-07-01T00:00:00Z'),
        memo: 'Opening balance',
        status: 'posted',
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [
          { id: 'jl_1', account: 'cash', debit: '100', credit: '0' },
          { id: 'jl_2', account: 'equity', debit: '0', credit: '100' },
        ],
      },
    ])

    const { GET } = await importRoute()
    const response = await GET(makeGet())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].lines).toHaveLength(2)
    expect(journalEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1' },
        orderBy: { entryDate: 'desc' },
        take: 50,
      }),
    )
  })

  it('honours a valid limit query param', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    journalEntryFindMany.mockResolvedValue([])

    const { GET } = await importRoute()
    const response = await GET(makeGet('?limit=10'))

    expect(response.status).toBe(200)
    expect(journalEntryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    )
  })

  it.each(['0', '101', 'abc', '2.5'])('returns 400 for invalid limit %p', async (limit) => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await importRoute()
    const response = await GET(makeGet(`?limit=${limit}`))

    expect(response.status).toBe(400)
    expect(journalEntryFindMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/routes-d/ledger/journal-entries (#1203)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('creates a balanced journal entry and returns 201', async () => {
    journalEntryCreate.mockResolvedValue({
      id: 'je_1',
      entryDate: new Date('2026-07-10T00:00:00Z'),
      memo: 'Invoice payment',
      status: 'posted',
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: [
        { id: 'jl_1', account: 'cash', debit: '100', credit: '0' },
        { id: 'jl_2', account: 'revenue', debit: '0', credit: '100' },
      ],
    })

    const { POST } = await importRoute()
    const response = await POST(
      makePost({ memo: 'Invoice payment', entryDate: '2026-07-10T00:00:00Z', lines: balancedLines }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.entry).toMatchObject({ id: 'je_1', memo: 'Invoice payment' })
    expect(journalEntryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_1',
          entryDate: new Date('2026-07-10T00:00:00Z'),
          memo: 'Invoice payment',
          lines: {
            create: [
              { account: 'cash', debit: 100, credit: 0 },
              { account: 'revenue', debit: 0, credit: 100 },
            ],
          },
        }),
      }),
    )
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost('not-json'))

    expect(response.status).toBe(400)
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when lines are missing or fewer than two', async () => {
    const { POST } = await importRoute()

    const missing = await POST(makePost({ memo: 'x' }))
    expect(missing.status).toBe(400)

    const single = await POST(makePost({ lines: [{ account: 'cash', debit: 10 }] }))
    expect(single.status).toBe(400)

    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when debits and credits do not balance', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makePost({
        lines: [
          { account: 'cash', debit: 100 },
          { account: 'revenue', credit: 90 },
        ],
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'total debits must equal total credits',
    })
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when a line has both debit and credit amounts', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makePost({
        lines: [
          { account: 'cash', debit: 100, credit: 100 },
          { account: 'revenue', credit: 0, debit: 0 },
        ],
      }),
    )

    expect(response.status).toBe(400)
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when a line is missing an account', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makePost({
        lines: [
          { debit: 100 },
          { account: 'revenue', credit: 100 },
        ],
      }),
    )

    expect(response.status).toBe(400)
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 for a negative amount', async () => {
    const { POST } = await importRoute()
    const response = await POST(
      makePost({
        lines: [
          { account: 'cash', debit: -100 },
          { account: 'revenue', credit: -100 },
        ],
      }),
    )

    expect(response.status).toBe(400)
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid entryDate', async () => {
    const { POST } = await importRoute()
    const response = await POST(makePost({ entryDate: 'not-a-date', lines: balancedLines }))

    expect(response.status).toBe(400)
    expect(journalEntryCreate).not.toHaveBeenCalled()
  })

  it('returns 500 when the database write fails', async () => {
    journalEntryCreate.mockRejectedValue(new Error('db down'))

    const { POST } = await importRoute()
    const response = await POST(makePost({ lines: balancedLines }))

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
