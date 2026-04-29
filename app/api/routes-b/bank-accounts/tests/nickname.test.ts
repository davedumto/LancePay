import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { bankAccountDisplayName } from '../../_lib/bank-accounts'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'
import { PATCH as PATCHById } from '../[id]/route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const fakeUser = { id: 'user-1', privyId: 'privy-1' }

function makeListReq(): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/bank-accounts', {
    method: 'GET',
    headers: { authorization: 'Bearer tok' },
  })
}

function makeCreateReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/bank-accounts', {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify(body),
  })
}

function makePatchReq(body: object, id = 'ba-1'): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/routes-b/bank-accounts/${id}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ]
}

const baseAccount = {
  id: 'ba-1',
  bankName: 'GTB',
  bankCode: '058',
  accountNumber: '0123456789',
  accountName: 'John Doe',
  isDefault: false,
  nickname: null,
  createdAt: new Date(),
}

describe('bankAccountDisplayName helper', () => {
  it('returns nickname when set', () => {
    expect(bankAccountDisplayName({ nickname: 'Personal', accountNumber: '0123456789', bankName: 'GTB' })).toBe('Personal')
  })

  it('returns fallback when no nickname', () => {
    expect(bankAccountDisplayName({ nickname: null, accountNumber: '0123456789', bankName: 'GTB' })).toBe('****6789 GTB')
  })
})

describe('GET /bank-accounts — nickname in list', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
  })

  it('shows displayName as fallback when no nickname', async () => {
    vi.mocked(prisma.bankAccount.findMany).mockResolvedValue([baseAccount] as any)
    const res = await GET(makeListReq())
    const body = await res.json()
    expect(body.bankAccounts[0].displayName).toBe('****6789 GTB')
    expect(body.bankAccounts[0].nickname).toBeNull()
  })

  it('shows nickname as displayName when set', async () => {
    vi.mocked(prisma.bankAccount.findMany).mockResolvedValue([
      { ...baseAccount, nickname: 'Savings' },
    ] as any)
    const res = await GET(makeListReq())
    const body = await res.json()
    expect(body.bankAccounts[0].displayName).toBe('Savings')
    expect(body.bankAccounts[0].nickname).toBe('Savings')
  })
})

describe('POST /bank-accounts — create with nickname', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
    vi.mocked(prisma.bankAccount.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.bankAccount.count).mockResolvedValue(0)
  })

  it('creates account with nickname and returns displayName', async () => {
    vi.mocked(prisma.bankAccount.create).mockResolvedValue({
      ...baseAccount,
      isDefault: true,
      nickname: 'Personal',
    } as any)
    const res = await POST(
      makeCreateReq({
        bankName: 'GTB',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'John Doe',
        nickname: 'Personal',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.displayName).toBe('Personal')
    expect(body.nickname).toBe('Personal')
  })

  it('creates account without nickname and returns fallback displayName', async () => {
    vi.mocked(prisma.bankAccount.create).mockResolvedValue({ ...baseAccount, isDefault: true } as any)
    const res = await POST(
      makeCreateReq({
        bankName: 'GTB',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'John Doe',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.displayName).toBe('****6789 GTB')
  })

  it('rejects nickname longer than 32 characters', async () => {
    const res = await POST(
      makeCreateReq({
        bankName: 'GTB',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'John Doe',
        nickname: 'A'.repeat(33),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('PATCH /bank-accounts/[id] — update nickname', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
    vi.mocked(prisma.bankAccount.findUnique).mockResolvedValue({ id: 'ba-1', userId: 'user-1' } as any)
  })

  it('sets nickname and returns updated displayName', async () => {
    vi.mocked(prisma.bankAccount.update).mockResolvedValue({
      ...baseAccount,
      nickname: 'Work',
    } as any)
    const [req, ctx] = makePatchReq({ nickname: 'Work' })
    const res = await PATCHById(req, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bankAccount.displayName).toBe('Work')
    expect(body.bankAccount.nickname).toBe('Work')
  })

  it('clears nickname when set to empty string', async () => {
    vi.mocked(prisma.bankAccount.update).mockResolvedValue({ ...baseAccount, nickname: null } as any)
    const [req, ctx] = makePatchReq({ nickname: '' })
    const res = await PATCHById(req, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bankAccount.nickname).toBeNull()
    expect(body.bankAccount.displayName).toBe('****6789 GTB')
  })

  it('returns 400 when body has neither isDefault nor nickname', async () => {
    const [req, ctx] = makePatchReq({ foo: 'bar' })
    const res = await PATCHById(req, ctx)
    expect(res.status).toBe(400)
  })

  it('rejects nickname longer than 32 characters', async () => {
    const [req, ctx] = makePatchReq({ nickname: 'A'.repeat(33) })
    const res = await PATCHById(req, ctx)
    expect(res.status).toBe(400)
  })
})
