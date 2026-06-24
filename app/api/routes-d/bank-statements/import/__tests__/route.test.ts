import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
  bankAccountFindFirst: vi.fn(),
  transactionFindUnique: vi.fn(),
  transactionCreate: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
    },
    bankAccount: {
      findFirst: mocks.bankAccountFindFirst,
    },
    transaction: {
      findUnique: mocks.transactionFindUnique,
      create: mocks.transactionCreate,
    },
  },
}))

import { POST } from '../route'

const BASE_URL = 'http://localhost/api/routes-d/bank-statements/import'

function makeRequest(body: unknown, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  headers.set('content-type', 'application/json')
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/bank-statements/import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const res = await POST(makeRequest({}, null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 if token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 401 if user is not found', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue(null)
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns 400 when body is not valid JSON', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1' })
    const headers = new Headers()
    headers.set('authorization', 'Bearer token')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers,
      body: 'invalid-json',
    })
    const res = await POST(request)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid JSON body')
  })

  it('returns 400 when parameters are invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1' })

    const res = await POST(makeRequest({ bankAccountId: 'not-a-uuid', transactions: [] }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Validation failed')
  })

  it('returns 404 when bank account is not found or does not belong to the user', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1' })
    mocks.bankAccountFindFirst.mockResolvedValue(null)

    const bankAccountId = crypto.randomUUID()
    const res = await POST(makeRequest({
      bankAccountId,
      transactions: [{
        externalId: 'tx-1',
        amount: 100,
        currency: 'USD',
        type: 'deposit',
        description: 'Test',
      }],
    }))

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Bank account not found')
  })

  it('successfully imports bank statement transactions and skips duplicates', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user-1' })
    const bankAccountId = crypto.randomUUID()
    mocks.bankAccountFindFirst.mockResolvedValue({ id: bankAccountId, userId: 'user-1' })

    // Mock first transaction as existing (duplicate) and second as new
    mocks.transactionFindUnique.mockImplementation(({ where }) => {
      if (where.externalId === 'tx-dup') {
        return Promise.resolve({ id: 'tx-existing' })
      }
      return Promise.resolve(null)
    })

    const res = await POST(makeRequest({
      bankAccountId,
      transactions: [
        {
          externalId: 'tx-dup',
          amount: 50,
          currency: 'USD',
          type: 'withdrawal',
          description: 'Duplicate transaction',
        },
        {
          externalId: 'tx-new',
          amount: 150.50,
          currency: 'USD',
          type: 'deposit',
          description: 'New transaction',
        },
      ],
    }))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.importedCount).toBe(1)
    expect(json.duplicatesCount).toBe(1)
    expect(mocks.transactionCreate).toHaveBeenCalledTimes(1)
    expect(mocks.transactionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        externalId: 'tx-new',
        amount: 150.50,
        currency: 'USD',
        type: 'deposit',
      }),
    }))
  })
})
