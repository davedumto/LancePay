import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    paymentMethod: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const NOW = new Date('2026-11-18T12:00:00.000Z')

function makeRequest(method: 'GET' | 'POST', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/payment-methods', { method, headers, body })
}

function mockPaymentMethod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pm-1',
    type: 'stellar_wallet',
    name: 'Main Wallet',
    value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
  vi.mocked(prisma.$transaction).mockImplementation(((fn: (tx: typeof prisma) => unknown) => fn(prisma)) as never)
})

describe('GET /api/payment-methods', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', undefined, {}))
    expect(res.status).toBe(401)
    expect(prisma.paymentMethod.findMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
    expect(prisma.paymentMethod.findMany).not.toHaveBeenCalled()
  })

  it('returns an empty list when the user has no payment methods', async () => {
    vi.mocked(prisma.paymentMethod.findMany).mockResolvedValue([])
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paymentMethods: [] })
  })

  it('returns all payment methods ordered by isDefault desc then createdAt desc', async () => {
    const pm1 = mockPaymentMethod({ id: 'pm-1', isDefault: true, createdAt: new Date('2026-11-17T10:00:00.000Z') })
    const pm2 = mockPaymentMethod({ id: 'pm-2', isDefault: false, createdAt: new Date('2026-11-18T12:00:00.000Z') })
    vi.mocked(prisma.paymentMethod.findMany).mockResolvedValue([pm1, pm2] as never)

    const res = await GET(makeRequest('GET'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.paymentMethods).toHaveLength(2)
    expect(body.paymentMethods[0].isDefault).toBe(true)

    expect(prisma.paymentMethod.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, type: true, name: true, value: true, isDefault: true, createdAt: true, updatedAt: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.paymentMethod.findMany).mockRejectedValue(new Error('connection refused'))
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch payment methods' })
  })
})

describe('POST /api/payment-methods', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'stellar_wallet', value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M' }), {}))
    expect(res.status).toBe(401)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'stellar_wallet', value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M' })))
    expect(res.status).toBe(401)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('creates a payment method with valid stellar wallet address', async () => {
    const pm = mockPaymentMethod()
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(0)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
      name: 'Main Wallet',
    })))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.paymentMethod).toEqual(pm)
  })

  it('creates a payment method with valid bank account', async () => {
    const pm = mockPaymentMethod({ type: 'bank_account', value: 'ACCOUNT1234567890' })
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(0)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'bank_account',
      value: 'ACCOUNT1234567890',
      name: 'Personal Savings',
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'bank_account',
          value: 'ACCOUNT1234567890',
        }),
      }),
    )
  })

  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('POST', '{not json'))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an empty body', async () => {
    const res = await POST(makeRequest('POST', ''))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a request with missing type', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a request with missing value', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'stellar_wallet' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an invalid type', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'invalid_type', value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an invalid stellar wallet address', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'stellar_wallet', value: 'invalid_address' })))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.details?.value).toBeDefined()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an invalid bank account format', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'bank_account', value: 'short' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an empty value', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ type: 'stellar_wallet', value: '   ' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('sets isDefault to true for the first payment method', async () => {
    const pm = mockPaymentMethod({ isDefault: true })
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(0)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } })
    expect(prisma.paymentMethod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true }),
      }),
    )
    expect(prisma.paymentMethod.updateMany).not.toHaveBeenCalled()
  })

  it('unsets isDefault on other methods when creating a new default method', async () => {
    const pm = mockPaymentMethod({ id: 'pm-2', isDefault: true })
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(1)
    vi.mocked(prisma.paymentMethod.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
      isDefault: true,
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isDefault: true },
      data: { isDefault: false },
    })
    expect(prisma.paymentMethod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true }),
      }),
    )
  })

  it('does not unset other defaults when creating a non-default method', async () => {
    const pm = mockPaymentMethod({ isDefault: false })
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(1)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
      isDefault: false,
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.updateMany).not.toHaveBeenCalled()
  })

  it('trims whitespace from value and name', async () => {
    const pm = mockPaymentMethod()
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(0)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: '  GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M  ',
      name: '  Main Wallet  ',
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
          name: 'Main Wallet',
        }),
      }),
    )
  })

  it('accepts optional name field', async () => {
    const pm = mockPaymentMethod({ name: null })
    vi.mocked(prisma.paymentMethod.count).mockResolvedValue(0)
    vi.mocked(prisma.paymentMethod.create).mockResolvedValue(pm as never)

    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
    })))

    expect(res.status).toBe(201)
    expect(prisma.paymentMethod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: null }),
      }),
    )
  })

  it('rejects unknown fields such as client-supplied userId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
      userId: 'someone-else',
    })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns a generic 500 on database error', async () => {
    vi.mocked(prisma.paymentMethod.count).mockRejectedValue(new Error('connection refused'))
    const res = await POST(makeRequest('POST', JSON.stringify({
      type: 'stellar_wallet',
      value: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RBWDUYCZ2FDPQLNV55PL7GZQLLM5M',
    })))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to create payment method' })
  })
})
