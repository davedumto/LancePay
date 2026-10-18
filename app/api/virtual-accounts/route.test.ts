import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockVirtualAccountFindUnique = vi.fn()
const mockVirtualAccountCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    virtualAccount: {
      findUnique: (...args: unknown[]) => mockVirtualAccountFindUnique(...args),
      create: (...args: unknown[]) => mockVirtualAccountCreate(...args),
    },
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

describe('Virtual Accounts API (/api/virtual-accounts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'user',
    })
  })

  it('returns the existing account (200) instead of erroring if one is already provisioned for userId', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockVirtualAccountFindUnique.mockResolvedValue({
      id: 'va-existing',
      userId: 'user-1',
      bankName: 'Wema Bank',
      accountNumber: '7820194821',
      accountName: 'Ada Lovelace',
      provider: 'paystack',
      providerRef: 'paystack_va_abc123',
      status: 'active',
      createdAt: now,
    })

    const req = makeRequest('http://localhost/api/virtual-accounts', {
      token: 'valid-token',
      body: {},
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.reusedExisting).toBe(true)
    expect(json.virtualAccount.id).toBe('va-existing')
    expect(json.virtualAccount.accountNumber).toBe('7820194821')
    expect(mockVirtualAccountCreate).not.toHaveBeenCalled()
  })

  it('validates accountNumber uniqueness before creating, surfacing a clean 409 conflict', async () => {
    mockVirtualAccountFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.userId) return null
      if (where.accountNumber === '1234567890') {
        return {
          id: 'va-other',
          userId: 'user-2',
          accountNumber: '1234567890',
        }
      }
      return null
    })

    const req = makeRequest('http://localhost/api/virtual-accounts', {
      token: 'valid-token',
      body: {
        bankName: 'Providus Bank',
        accountNumber: '1234567890',
        provider: 'paystack',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('ACCOUNT_NUMBER_CONFLICT')
    expect(mockVirtualAccountCreate).not.toHaveBeenCalled()
  })

  it('provisions a new virtual account with status defaulted to active and providerRef stored for reconciliation', async () => {
    const now = new Date('2026-04-02T10:00:00Z')
    mockVirtualAccountFindUnique.mockResolvedValue(null)
    mockVirtualAccountCreate.mockImplementation(async ({ data }: any) => ({
      id: 'va-new',
      ...data,
      createdAt: now,
    }))

    const req = makeRequest('http://localhost/api/virtual-accounts', {
      token: 'valid-token',
      body: {
        bankName: 'Wema Bank',
        accountNumber: '9081726354',
        provider: 'flutterwave',
        providerRef: 'flw_ref_998877',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.reusedExisting).toBe(false)
    expect(json.virtualAccount.id).toBe('va-new')
    expect(json.virtualAccount.status).toBe('active')
    expect(json.virtualAccount.providerRef).toBe('flw_ref_998877')
    expect(json.virtualAccount.accountNumber).toBe('9081726354')

    // Also verify GET returns the provisioned account
    mockVirtualAccountFindUnique.mockResolvedValueOnce({
      id: 'va-new',
      userId: 'user-1',
      bankName: 'Wema Bank',
      accountNumber: '9081726354',
      accountName: 'Ada Lovelace',
      provider: 'flutterwave',
      providerRef: 'flw_ref_998877',
      status: 'active',
      createdAt: now,
    })

    const resGet = await GET(
      makeRequest('http://localhost/api/virtual-accounts', {
        method: 'GET',
        token: 'valid-token',
      }),
    )
    expect(resGet.status).toBe(200)
  })
})
