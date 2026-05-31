import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const mockFindFirst = vi.mocked(prisma.bankAccount.findFirst)
const mockCount = vi.mocked(prisma.bankAccount.count)
const mockCreate = vi.mocked(prisma.bankAccount.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }

const validBody = {
  bankName: 'Access Bank',
  bankCode: '044',
  accountNumber: '0123456789',
  accountName: 'Jane Doe',
}

function makePostReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/bank-accounts', {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-b/bank-accounts — duplicate detection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockUserFind.mockResolvedValue(fakeUser as never)
  })

  it('returns 409 when account number + bank code already exist for user', async () => {
    mockFindFirst.mockResolvedValue({ id: 'ba-existing' } as never)

    const res = await POST(makePostReq(validBody))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatch(/already exists/i)
    expect(body.existingId).toBe('ba-existing')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates account when no duplicate exists', async () => {
    mockFindFirst.mockResolvedValue(null as never)
    mockCount.mockResolvedValue(1 as never)
    mockCreate.mockResolvedValue({
      id: 'ba-new',
      ...validBody,
      isDefault: false,
      nickname: null,
      createdAt: new Date(),
    } as never)

    const res = await POST(makePostReq(validBody))

    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalled()
  })

  it('queries with case-insensitive matching on accountNumber and bankCode', async () => {
    mockFindFirst.mockResolvedValue(null as never)
    mockCount.mockResolvedValue(0 as never)
    mockCreate.mockResolvedValue({
      id: 'ba-new',
      ...validBody,
      isDefault: true,
      nickname: null,
      createdAt: new Date(),
    } as never)

    await POST(makePostReq(validBody))

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: fakeUser.id,
          accountNumber: expect.objectContaining({ mode: 'insensitive' }),
          bankCode: expect.objectContaining({ mode: 'insensitive' }),
        }),
      }),
    )
  })

  it('sets isDefault=true for first bank account added', async () => {
    mockFindFirst.mockResolvedValue(null as never)
    mockCount.mockResolvedValue(0 as never)
    mockCreate.mockResolvedValue({
      id: 'ba-first',
      ...validBody,
      isDefault: true,
      nickname: null,
      createdAt: new Date(),
    } as never)

    await POST(makePostReq(validBody))

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true }),
      }),
    )
  })

  it('sets isDefault=false when user already has bank accounts', async () => {
    mockFindFirst.mockResolvedValue(null as never)
    mockCount.mockResolvedValue(2 as never)
    mockCreate.mockResolvedValue({
      id: 'ba-second',
      ...validBody,
      isDefault: false,
      nickname: null,
      createdAt: new Date(),
    } as never)

    await POST(makePostReq(validBody))

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: false }),
      }),
    )
  })

  it('returns 401 when no auth token', async () => {
    mockVerify.mockResolvedValue(null as never)

    const res = await POST(makePostReq(validBody))

    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid accountNumber format', async () => {
    const res = await POST(makePostReq({ ...validBody, accountNumber: '123' }))

    expect(res.status).toBe(400)
    expect(mockFindFirst).not.toHaveBeenCalled()
  })
})
