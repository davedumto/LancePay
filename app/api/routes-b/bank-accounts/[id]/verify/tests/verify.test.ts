import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { resetVerifyStore } from '../../../../_lib/verify-store'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST as startPOST } from '../start/route'
import { POST as confirmPOST } from '../confirm/route'

const mockVerify = vi.mocked(verifyAuthToken)
const mockUserFind = vi.mocked(prisma.user.findUnique)
const mockAccountFind = vi.mocked(prisma.bankAccount.findUnique)
const mockAccountUpdate = vi.mocked(prisma.bankAccount.update)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }
const fakeAccount = { id: 'bank-1', userId: 'user-1', isVerified: false }

function makeReq(method: string, body?: unknown, accountId = 'bank-1'): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(`http://localhost/api/routes-b/bank-accounts/${accountId}/verify/start`, {
    method,
    headers: { authorization: 'Bearer tok' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return [req, { params: Promise.resolve({ id: accountId }) }]
}

describe('POST /bank-accounts/[id]/verify/start', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetVerifyStore()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
    mockAccountFind.mockResolvedValue(fakeAccount as any)
  })

  it('returns 401 when no token', async () => {
    const [req, ctx] = makeReq('POST')
    const noAuthReq = new NextRequest(req.url, { method: 'POST' })
    const res = await startPOST(noAuthReq, ctx)
    expect(res.status).toBe(401)
  })

  it('returns 404 when account not found', async () => {
    mockAccountFind.mockResolvedValue(null)
    const [req, ctx] = makeReq('POST')
    const res = await startPOST(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 403 when account belongs to another user', async () => {
    mockAccountFind.mockResolvedValue({ ...fakeAccount, userId: 'other-user' } as any)
    const [req, ctx] = makeReq('POST')
    const res = await startPOST(req, ctx)
    expect(res.status).toBe(403)
  })

  it('returns 201 with simulatedAmount on start', async () => {
    const [req, ctx] = makeReq('POST')
    const res = await startPOST(req, ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.simulatedAmount).toBe(0.01)
    expect(body.message).toMatch(/initiated/i)
  })

  it('returns 200 when already verified', async () => {
    mockAccountFind.mockResolvedValue({ ...fakeAccount, isVerified: true } as any)
    const [req, ctx] = makeReq('POST')
    const res = await startPOST(req, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/already verified/i)
  })
})

describe('POST /bank-accounts/[id]/verify/confirm', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetVerifyStore()
    mockVerify.mockResolvedValue({ userId: 'privy-1' } as any)
    mockUserFind.mockResolvedValue(fakeUser as any)
    mockAccountFind.mockResolvedValue(fakeAccount as any)
    mockAccountUpdate.mockResolvedValue({ ...fakeAccount, isVerified: true } as any)
  })

  it('returns 400 when verification not started', async () => {
    const [req, ctx] = makeReq('POST', { amount: 0.01 })
    const res = await confirmPOST(req, ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not started/i)
  })

  it('returns 200 and sets isVerified on correct amount', async () => {
    // start first
    const [startReq, ctx] = makeReq('POST')
    await startPOST(startReq, ctx)

    const [confirmReq, confirmCtx] = makeReq('POST', { amount: 0.01 })
    const res = await confirmPOST(confirmReq, confirmCtx)
    expect(res.status).toBe(200)
    expect(mockAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'bank-1' },
      data: { isVerified: true },
    })
  })

  it('returns 422 on wrong amount with attemptsLeft', async () => {
    const [startReq, ctx] = makeReq('POST')
    await startPOST(startReq, ctx)

    const [confirmReq, confirmCtx] = makeReq('POST', { amount: 0.99 })
    const res = await confirmPOST(confirmReq, confirmCtx)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.attemptsLeft).toBe(2)
  })

  it('locks after 3 failed attempts (429)', async () => {
    const [startReq, ctx] = makeReq('POST')
    await startPOST(startReq, ctx)

    for (let i = 0; i < 3; i++) {
      const [req, c] = makeReq('POST', { amount: 0.99 })
      await confirmPOST(req, c)
    }

    const [req, c] = makeReq('POST', { amount: 0.01 })
    const res = await confirmPOST(req, c)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.lockedUntil).toBeDefined()
  })

  it('returns 400 when amount is not a number', async () => {
    const [startReq, ctx] = makeReq('POST')
    await startPOST(startReq, ctx)

    const [req, c] = makeReq('POST', { amount: 'abc' })
    const res = await confirmPOST(req, c)
    expect(res.status).toBe(400)
  })
})
