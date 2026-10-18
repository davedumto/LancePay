import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockPaymentMethodFindMany = vi.fn()
const mockPaymentMethodCount = vi.fn()
const mockPaymentMethodUpdateMany = vi.fn()
const mockPaymentMethodCreate = vi.fn()

const txClient = {
  paymentMethod: {
    findMany: (...args: unknown[]) => mockPaymentMethodFindMany(...args),
    count: (...args: unknown[]) => mockPaymentMethodCount(...args),
    updateMany: (...args: unknown[]) => mockPaymentMethodUpdateMany(...args),
    create: (...args: unknown[]) => mockPaymentMethodCreate(...args),
  },
}

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    paymentMethod: {
      findMany: (...args: unknown[]) => mockPaymentMethodFindMany(...args),
      count: (...args: unknown[]) => mockPaymentMethodCount(...args),
      updateMany: (...args: unknown[]) => mockPaymentMethodUpdateMany(...args),
      create: (...args: unknown[]) => mockPaymentMethodCreate(...args),
    },
    $transaction: vi.fn(async (cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST } from './route'

const VALID_STELLAR_KEY =
  'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Payment Methods API (/api/payment-methods)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('validates type against the allowed set and validates value/details format matches the declared type', async () => {
    const reqBadType = makeRequest('http://localhost/api/payment-methods', {
      token: 'valid-token',
      body: { type: 'carrier_pigeon', value: VALID_STELLAR_KEY },
    })
    const resBadType = await POST(reqBadType)
    expect(resBadType.status).toBe(400)
    const jsonBadType = await resBadType.json()
    expect(jsonBadType.code).toBe('INVALID_PAYMENT_METHOD_TYPE')

    // Mismatched details: bank account number provided for stellar_wallet
    const reqBadStellar = makeRequest('http://localhost/api/payment-methods', {
      token: 'valid-token',
      body: { type: 'stellar_wallet', value: 'not-a-stellar-key-12345' },
    })
    const resBadStellar = await POST(reqBadStellar)
    expect(resBadStellar.status).toBe(400)
    const jsonBadStellar = await resBadStellar.json()
    expect(jsonBadStellar.code).toBe('INVALID_PAYMENT_METHOD_DETAILS')

    // Mismatched details: Stellar key provided for bank_account
    const reqBadBank = makeRequest('http://localhost/api/payment-methods', {
      token: 'valid-token',
      body: { type: 'bank_account', value: VALID_STELLAR_KEY },
    })
    const resBadBank = await POST(reqBadBank)
    expect(resBadBank.status).toBe(400)
    const jsonBadBank = await resBadBank.json()
    expect(jsonBadBank.code).toBe('INVALID_PAYMENT_METHOD_DETAILS')

    expect(mockPaymentMethodCreate).not.toHaveBeenCalled()
  })

  it('automatically defaults isDefault to true when registering the user first payment method', async () => {
    mockPaymentMethodCount.mockResolvedValue(0)
    mockPaymentMethodCreate.mockImplementation(async ({ data }: any) => ({
      id: 'pm-first',
      ...data,
      createdAt: new Date('2026-04-01T10:00:00Z'),
      updatedAt: new Date('2026-04-01T10:00:00Z'),
    }))

    const req = makeRequest('http://localhost/api/payment-methods', {
      token: 'valid-token',
      body: {
        type: 'stellar_wallet',
        name: 'Primary Stellar',
        value: VALID_STELLAR_KEY,
        isDefault: false, // Even if false or omitted, first method becomes default
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.paymentMethod.id).toBe('pm-first')
    expect(json.paymentMethod.isDefault).toBe(true)
    expect(mockPaymentMethodUpdateMany).not.toHaveBeenCalled()
  })

  it('atomically unsets isDefault on all other methods for that user in the same transaction when isDefault is true', async () => {
    mockPaymentMethodCount.mockResolvedValue(2)
    mockPaymentMethodUpdateMany.mockResolvedValue({ count: 1 })
    mockPaymentMethodCreate.mockImplementation(async ({ data }: any) => ({
      id: 'pm-new-default',
      ...data,
      createdAt: new Date('2026-04-02T10:00:00Z'),
      updatedAt: new Date('2026-04-02T10:00:00Z'),
    }))

    const req = makeRequest('http://localhost/api/payment-methods', {
      token: 'valid-token',
      body: {
        type: 'bank_account',
        name: 'Business Checking',
        value: '0123456789',
        isDefault: true,
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.paymentMethod.id).toBe('pm-new-default')
    expect(json.paymentMethod.isDefault).toBe(true)

    expect(mockPaymentMethodUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isDefault: true },
      data: { isDefault: false },
    })
    expect(mockPaymentMethodCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        type: 'bank_account',
        name: 'Business Checking',
        value: '0123456789',
        isDefault: true,
      },
    })
  })
})
