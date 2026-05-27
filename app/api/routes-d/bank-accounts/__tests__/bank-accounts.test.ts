import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))
vi.mock('../_shared/logger', () => ({
  createRouteLogger: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  logger: { error: vi.fn() },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedFindMany = vi.mocked(prisma.bankAccount.findMany)
const mockedFindFirst = vi.mocked(prisma.bankAccount.findFirst)
const mockedCount = vi.mocked(prisma.bankAccount.count)
const mockedCreate = vi.mocked(prisma.bankAccount.create)

function getReq(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/bank-accounts', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

function postReq(body: unknown, auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/bank-accounts', {
    method: 'POST',
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validAccount = {
  bankName: 'First Bank',
  bankCode: '011',
  accountNumber: '3012345678',
  accountName: 'Jane Doe',
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedFindFirst.mockResolvedValue(null as never)
})

describe('GET /api/routes-d/bank-accounts', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(getReq(''))).status).toBe(401)
  })

  it('lists accounts with the account number masked', async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: 'b1',
        bankName: 'First Bank',
        bankCode: '011',
        accountNumber: '3012345678',
        accountName: 'Jane Doe',
        isDefault: true,
        createdAt: new Date(),
      },
    ] as never)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.bankAccounts[0].accountNumber).toBe('******5678')
  })
})

describe('POST /api/routes-d/bank-accounts', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await POST(postReq(validAccount, ''))).status).toBe(401)
  })

  it('returns 400 on invalid JSON', async () => {
    expect((await POST(postReq('not json'))).status).toBe(400)
  })

  it('returns 400 when bankName is missing', async () => {
    const { bankName: _omit, ...rest } = validAccount
    expect((await POST(postReq(rest))).status).toBe(400)
  })

  it('returns 400 for a malformed bank code', async () => {
    expect((await POST(postReq({ ...validAccount, bankCode: 'AB' }))).status).toBe(400)
  })

  it('returns 400 for a malformed account number', async () => {
    expect((await POST(postReq({ ...validAccount, accountNumber: '123' }))).status).toBe(400)
  })

  it('creates a bank account for a valid payload', async () => {
    mockedCount.mockResolvedValue(0 as never)
    mockedCreate.mockResolvedValue({
      id: 'b1',
      ...validAccount,
      isDefault: true,
      createdAt: new Date(),
    } as never)
    const res = await POST(postReq(validAccount))
    expect([200, 201]).toContain(res.status)
    expect(mockedCreate).toHaveBeenCalled()
  })

  it('returns 409 when bank account already exists', async () => {
    mockedFindFirst.mockResolvedValue({ id: 'existing-b1' } as never)
    const res = await POST(postReq(validAccount))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/already exists/i)
    expect(json.existingId).toBe('existing-b1')
  })

  it('does not create when a duplicate account is detected', async () => {
    mockedFindFirst.mockResolvedValue({ id: 'existing-b1' } as never)
    await POST(postReq(validAccount))
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it('allows creation when no duplicate exists', async () => {
    mockedFindFirst.mockResolvedValue(null as never)
    mockedCount.mockResolvedValue(0 as never)
    mockedCreate.mockResolvedValue({
      id: 'b2',
      ...validAccount,
      isDefault: true,
      createdAt: new Date(),
    } as never)
    const res = await POST(postReq(validAccount))
    expect([200, 201]).toContain(res.status)
  })
})
