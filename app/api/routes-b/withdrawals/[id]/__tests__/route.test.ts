import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFind = vi.mocked(prisma.transaction.findUnique)

function makeGET(id = 'tx-1', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/withdrawals/${id}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token', ...headers },
  })
}

describe('GET /api/routes-b/withdrawals/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    delete process.env.OFFRAMP_STATUS_URL
  })

  describe('happy path', () => {
    it('returns withdrawal with correct structure', async () => {
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      } as never)

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.withdrawal).toMatchObject({
        id: 'tx-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        description: null,
        stellarTxHash: null,
      })
    })

    it('includes requestId in response headers', async () => {
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: null,
        createdAt: new Date(),
      } as never)

      const res = await GET(makeGET('tx-1', { 'x-request-id': 'req-123' }), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.headers.get('X-Request-Id')).toBe('req-123')
    })

    it('generates requestId if not provided', async () => {
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: null,
        createdAt: new Date(),
      } as never)

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.headers.get('X-Request-Id')).toBeTruthy()
    })
  })

  describe('auth and ownership', () => {
    it('returns 401 when auth token is missing', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/withdrawals/tx-1', {
        method: 'GET',
      })
      const res = await GET(req, { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 401 when auth token is invalid', async () => {
      mockVerifyAuthToken.mockResolvedValueOnce(null)
      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 404 when user not found', async () => {
      mockedUserFind.mockResolvedValueOnce(null)
      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'User not found',
      })
    })

    it('returns 404 when withdrawal not found', async () => {
      mockedTxFind.mockResolvedValueOnce(null)
      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Withdrawal not found',
      })
    })

    it('returns 404 when transaction is not a withdrawal', async () => {
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'payment',
        status: 'completed',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: null,
        createdAt: new Date(),
      } as never)

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Withdrawal not found',
      })
    })

    it('returns 403 when user does not own the withdrawal', async () => {
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-2',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: null,
        createdAt: new Date(),
      } as never)

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Forbidden',
      })
    })
  })

  describe('error handling', () => {
    it('returns structured error on unexpected error', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database connection failed'))
      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'INTERNAL',
        message: 'Failed to fetch withdrawal',
      })
      expect(json.requestId).toBeTruthy()
    })

    it('includes requestId in error response', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database error'))
      const res = await GET(makeGET('tx-1', { 'x-request-id': 'error-req-456' }), { params: Promise.resolve({ id: 'tx-1' }) })
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.requestId).toBe('error-req-456')
    })
  })

  describe('upstream status integration', () => {
    it('falls back to transaction status when upstream fails after retries', async () => {
      process.env.OFFRAMP_STATUS_URL = 'https://offramp.example/status'
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: 'hash-1',
        createdAt: new Date(),
      } as never)

      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      vi.spyOn(Math, 'random').mockReturnValue(0)
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))

      const promise = GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await promise
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.withdrawal.status).toBe('pending')

      vi.useRealTimers()
    })

    it('uses upstream status when upstream succeeds', async () => {
      process.env.OFFRAMP_STATUS_URL = 'https://offramp.example/status'
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'pending',
        amount: 123,
        currency: 'USDC',
        error: null,
        txHash: 'hash-1',
        createdAt: new Date(),
      } as never)

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: 'completed', description: 'done' }),
        } as any),
      )

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      const json = await res.json()
      expect(json.withdrawal.status).toBe('completed')
      expect(json.withdrawal.description).toBe('done')
    })

    it('returns transaction error when no upstream status available', async () => {
      delete process.env.OFFRAMP_STATUS_URL
      mockedTxFind.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        type: 'withdrawal',
        status: 'failed',
        amount: 123,
        currency: 'USDC',
        error: 'Insufficient funds',
        txHash: null,
        createdAt: new Date(),
      } as never)

      const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
      const json = await res.json()
      expect(json.withdrawal.status).toBe('failed')
      expect(json.withdrawal.description).toBe('Insufficient funds')
    })
  })
})

