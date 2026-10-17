import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { hashToken } from '@/lib/crypto'
import { DELETE } from './route'
import { GET as getView } from '../[token]/view/route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    incomeVerification: { findUnique: vi.fn(), delete: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockVerificationFindUnique = prisma.incomeVerification
  .findUnique as unknown as ReturnType<typeof vi.fn>
const mockVerificationDelete = prisma.incomeVerification
  .delete as unknown as ReturnType<typeof vi.fn>
const mockVerificationUpdate = prisma.incomeVerification
  .update as unknown as ReturnType<typeof vi.fn>

function makeDelete(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/income-verifications/${id}`, {
    method: 'DELETE',
    headers,
  })
}

function callDelete(id: string, token: string | null = 'Bearer valid-token') {
  return DELETE(makeDelete(id, token), { params: Promise.resolve({ id }) })
}

const now = new Date()
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

const mockVerification = { id: 'iv-1', userId: 'user-1', expiresAt: tomorrow }
const expiredVerification = { id: 'iv-2', userId: 'user-1', expiresAt: yesterday }

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' })
  mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
  mockVerificationFindUnique.mockResolvedValue(mockVerification)
  mockVerificationDelete.mockResolvedValue(mockVerification)
})

describe('DELETE /api/income-verifications/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await callDelete('iv-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await callDelete('iv-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    mockUserFindUnique.mockResolvedValue(null)
    const res = await callDelete('iv-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the income verification does not exist or was already revoked', async () => {
    mockVerificationFindUnique.mockResolvedValue(null)
    const res = await callDelete('missing')
    expect(res.status).toBe(404)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('returns 403 when the verification belongs to another user', async () => {
    mockVerificationFindUnique.mockResolvedValue({
      ...mockVerification,
      userId: 'someone-else',
    })
    const res = await callDelete('iv-1')
    expect(res.status).toBe(403)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('returns 404 when the income verification has already expired', async () => {
    mockVerificationFindUnique.mockResolvedValue(expiredVerification)
    const res = await callDelete('iv-2')
    expect(res.status).toBe(404)
    expect(mockVerificationDelete).not.toHaveBeenCalled()
  })

  it('deletes the verification and returns 200 on the happy path', async () => {
    const res = await callDelete('iv-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('iv-1')
    expect(json.revoked).toBe(true)
    expect(mockVerificationDelete).toHaveBeenCalledWith({ where: { id: 'iv-1' } })
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockVerificationDelete.mockRejectedValue(new Error('db unavailable'))
    const res = await callDelete('iv-1')
    expect(res.status).toBe(500)
  })

  it('takes effect immediately so any subsequent view attempt or second DELETE returns 404', async () => {
    const rawToken = 'valid-income-verification-token'
    const tokenHash = hashToken(rawToken)

    // First DELETE call succeeds and removes the record
    let deleted = false
    mockVerificationFindUnique.mockImplementation(async () => (deleted ? null : {
      id: 'iv-1',
      userId: 'user-1',
      tokenHash,
      recipientName: 'Mortgage Lender',
      expiresAt: tomorrow,
      accessCount: 0,
      createdAt: now,
    }))
    mockVerificationDelete.mockImplementation(async () => {
      deleted = true
      return mockVerification
    })

    const deleteRes = await callDelete('iv-1')
    expect(deleteRes.status).toBe(200)
    expect(mockVerificationDelete).toHaveBeenCalledTimes(1)

    // Subsequent view attempt at GET /api/income-verifications/[token]/view fails immediately with 404
    const viewReq = new NextRequest(`http://localhost/api/income-verifications/${rawToken}/view`, {
      method: 'GET',
    })
    const viewRes = await getView(viewReq, { params: Promise.resolve({ token: rawToken }) })
    expect(viewRes.status).toBe(404)
    expect(mockVerificationUpdate).not.toHaveBeenCalled()

    // Second DELETE attempt on the already-revoked link returns 404 cleanly
    const secondDeleteRes = await callDelete('iv-1')
    expect(secondDeleteRes.status).toBe(404)
  })
})
