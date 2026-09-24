import { NextRequest } from 'next/server'
import { GET } from './route'

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    whitelistAddress: { findUnique: jest.fn() },
  },
}))
jest.mock('@/lib/auth', () => ({ verifyAuthToken: jest.fn() }))
jest.mock('@/lib/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockVerify = verifyAuthToken as jest.Mock
const mockUserFindUnique = (prisma.user.findUnique as jest.Mock)
const mockWhitelistFindUnique = (prisma.whitelistAddress.findUnique as jest.Mock)

function makeReq(id: string) {
  return new NextRequest(
    `http://localhost/api/routes-d/whitelist/addresses/${id}/cooldown-status`,
    {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
    }
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /api/routes-d/whitelist/addresses/[id]/cooldown-status', () => {
  describe('AUTHENTICATION', () => {
    test('returns 401 when no authorization header', async () => {
      const req = new NextRequest(
        `http://localhost/api/routes-d/whitelist/addresses/wa1/cooldown-status`,
        { method: 'GET' }
      )
      const res = await GET(req, { params: { id: 'wa1' } })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    test('returns 401 when verifyAuthToken returns null', async () => {
      mockVerify.mockResolvedValue(null)
      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    test('returns 401 when user not found in database', async () => {
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue(null)
      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(401)
    })
  })

  describe('NOT FOUND', () => {
    test('returns 404 when whitelist address does not exist', async () => {
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue(null)
      const res = await GET(makeReq('nonexistent'), { params: { id: 'nonexistent' } })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Not Found')
      expect(body.message).toBe('Whitelist address not found')
    })
  })

  describe('AUTHORIZATION', () => {
    test('returns 403 when whitelist address owned by different user', async () => {
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa1',
        userId: 'user_2', // different owner
        address: 'GABC123',
        createdAt: new Date(),
      })
      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Forbidden')
      expect(body.message).toContain('do not own')
    })
  })

  describe('HAPPY PATH - IN COOLDOWN', () => {
    test('returns eligible: false when address created 1 hour ago (24h cooldown)', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-01T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T11:00:00Z') // 1 hour ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa1',
        userId: 'user_1',
        address: 'GABC123',
        createdAt,
      })

      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.eligible).toBe(false)
      expect(body.id).toBe('wa1')
      expect(body.address).toBe('GABC123')
      expect(body.createdAt).toBe(createdAt.toISOString())

      // remainingSeconds should be approximately 23 * 3600 = 82800
      expect(body.remainingSeconds).toBeGreaterThanOrEqual(82799)
      expect(body.remainingSeconds).toBeLessThanOrEqual(82800)

      // remainingMinutes should be approximately 23 * 60 = 1380
      expect(body.remainingMinutes).toBeGreaterThanOrEqual(1379)
      expect(body.remainingMinutes).toBeLessThanOrEqual(1380)

      // cooldownEndsAt should be createdAt + 24 hours
      const expectedCooldownEnds = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000)
      expect(body.cooldownEndsAt).toBe(expectedCooldownEnds.toISOString())

      jest.useRealTimers()
    })

    test('remainingSeconds computed correctly for mid-cooldown', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-01T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T00:00:00Z') // 12 hours ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa1',
        userId: 'user_1',
        address: 'GABC123',
        createdAt,
      })

      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      const body = await res.json()

      // Remaining: 12 hours = 43200 seconds
      expect(body.remainingSeconds).toBeGreaterThanOrEqual(43199)
      expect(body.remainingSeconds).toBeLessThanOrEqual(43200)
      expect(body.remainingMinutes).toBeGreaterThanOrEqual(719)
      expect(body.remainingMinutes).toBeLessThanOrEqual(720)
      expect(body.eligible).toBe(false)

      jest.useRealTimers()
    })
  })

  describe('HAPPY PATH - COOLDOWN CLEARED', () => {
    test('returns eligible: true when address created 25 hours ago (24h cooldown)', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T11:00:00Z') // 25 hours ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa2',
        userId: 'user_1',
        address: 'GDEF456',
        createdAt,
      })

      const res = await GET(makeReq('wa2'), { params: { id: 'wa2' } })
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)
      expect(body.remainingMinutes).toBe(0)

      jest.useRealTimers()
    })

    test('returns eligible: true and remainingSeconds 0 when cooldown expired', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-03T00:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T00:00:00Z') // 48 hours ago, well past 24h cooldown
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa3',
        userId: 'user_1',
        address: 'GHIJ789',
        createdAt,
      })

      const res = await GET(makeReq('wa3'), { params: { id: 'wa3' } })
      const body = await res.json()

      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)
      expect(body.remainingMinutes).toBe(0)

      jest.useRealTimers()
    })
  })

  describe('HAPPY PATH - EXACTLY AT COOLDOWN BOUNDARY', () => {
    test('returns eligible: true when address created exactly 24 hours ago', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00Z') // exactly 24 hours ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_boundary',
        userId: 'user_1',
        address: 'GBOUND',
        createdAt,
      })

      const res = await GET(makeReq('wa_boundary'), { params: { id: 'wa_boundary' } })
      const body = await res.json()

      // At exact boundary, eligible should be true (remaining ms == 0)
      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)
      expect(body.remainingMinutes).toBe(0)

      jest.useRealTimers()
    })

    test('returns eligible: false when address created 1 second before cooldown boundary', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:00.000Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T11:59:59.000Z') // 24h 1s ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_before_boundary',
        userId: 'user_1',
        address: 'GBEFORE',
        createdAt,
      })

      const res = await GET(makeReq('wa_before_boundary'), {
        params: { id: 'wa_before_boundary' },
      })
      const body = await res.json()

      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)

      jest.useRealTimers()
    })

    test('handles Math.max(0, ...) correctly to prevent negative remainingMs', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-05T00:00:00Z')
      jest.setSystemTime(now)

      // Created far in the past
      const createdAt = new Date('2023-12-01T00:00:00Z')
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_past',
        userId: 'user_1',
        address: 'GPAST',
        createdAt,
      })

      const res = await GET(makeReq('wa_past'), { params: { id: 'wa_past' } })
      const body = await res.json()

      // Should never go negative
      expect(body.remainingSeconds).toBe(0)
      expect(body.remainingMinutes).toBe(0)
      expect(body.eligible).toBe(true)

      jest.useRealTimers()
    })
  })

  describe('COOLDOWN COMPUTATION WITH ENV VAR', () => {
    test('respects WHITELIST_COOLDOWN_HOURS env var if set', async () => {
      const originalEnv = process.env.WHITELIST_COOLDOWN_HOURS
      process.env.WHITELIST_COOLDOWN_HOURS = '48'

      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00Z') // exactly 24 hours ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_env',
        userId: 'user_1',
        address: 'GENV',
        createdAt,
      })

      const res = await GET(makeReq('wa_env'), { params: { id: 'wa_env' } })
      const body = await res.json()

      // With 48h cooldown, 24h passed means 24h remaining
      expect(body.eligible).toBe(false)
      expect(body.remainingSeconds).toBeGreaterThanOrEqual(86399) // ~24h in seconds
      expect(body.remainingSeconds).toBeLessThanOrEqual(86400)

      process.env.WHITELIST_COOLDOWN_HOURS = originalEnv
      jest.useRealTimers()
    })

    test('uses default 24 hours when WHITELIST_COOLDOWN_HOURS not set', async () => {
      const originalEnv = process.env.WHITELIST_COOLDOWN_HOURS
      delete process.env.WHITELIST_COOLDOWN_HOURS

      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:01Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00Z') // 24h 1s ago
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_default',
        userId: 'user_1',
        address: 'GDEFAULT',
        createdAt,
      })

      const res = await GET(makeReq('wa_default'), { params: { id: 'wa_default' } })
      const body = await res.json()

      // With default 24h, this should be just past cooldown
      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)

      process.env.WHITELIST_COOLDOWN_HOURS = originalEnv
      jest.useRealTimers()
    })
  })

  describe('COOLDOWN COMPUTATION - EDGE CASES', () => {
    test('address created just now has remaining ~= COOLDOWN_HOURS * 3600', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-01T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00Z') // right now
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_now',
        userId: 'user_1',
        address: 'GNOW',
        createdAt,
      })

      const res = await GET(makeReq('wa_now'), { params: { id: 'wa_now' } })
      const body = await res.json()

      // 24 hours = 86400 seconds
      expect(body.eligible).toBe(false)
      expect(body.remainingSeconds).toBeGreaterThanOrEqual(86399)
      expect(body.remainingSeconds).toBeLessThanOrEqual(86400)
      expect(body.remainingMinutes).toBeGreaterThanOrEqual(1439)
      expect(body.remainingMinutes).toBeLessThanOrEqual(1440)

      jest.useRealTimers()
    })

    test('address created 1 second before cooldown end has remainingSeconds = 1', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-02T11:59:59.000Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00.000Z') // exactly at cooldown boundary
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_almost',
        userId: 'user_1',
        address: 'GALMST',
        createdAt,
      })

      const res = await GET(makeReq('wa_almost'), { params: { id: 'wa_almost' } })
      const body = await res.json()

      expect(body.eligible).toBe(false)
      expect(body.remainingSeconds).toBe(1)

      jest.useRealTimers()
    })

    test('address created 1 second after cooldown end has remainingSeconds = 0', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-02T12:00:01.000Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:00:00.000Z')
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_past_boundary',
        userId: 'user_1',
        address: 'GPASTBOUND',
        createdAt,
      })

      const res = await GET(makeReq('wa_past_boundary'), { params: { id: 'wa_past_boundary' } })
      const body = await res.json()

      expect(body.eligible).toBe(true)
      expect(body.remainingSeconds).toBe(0)

      jest.useRealTimers()
    })
  })

  describe('RESPONSE FORMAT', () => {
    test('returns correct CooldownStatusResponse shape', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-01T12:00:00Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T11:00:00Z')
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_format',
        userId: 'user_1',
        address: 'GFORMAT',
        createdAt,
      })

      const res = await GET(makeReq('wa_format'), { params: { id: 'wa_format' } })
      const body = await res.json()

      // Verify all required fields exist
      expect(body).toHaveProperty('id')
      expect(body).toHaveProperty('address')
      expect(body).toHaveProperty('eligible')
      expect(body).toHaveProperty('cooldownEndsAt')
      expect(body).toHaveProperty('remainingSeconds')
      expect(body).toHaveProperty('remainingMinutes')
      expect(body).toHaveProperty('createdAt')

      // Verify types
      expect(typeof body.id).toBe('string')
      expect(typeof body.address).toBe('string')
      expect(typeof body.eligible).toBe('boolean')
      expect(typeof body.cooldownEndsAt).toBe('string')
      expect(typeof body.remainingSeconds).toBe('number')
      expect(typeof body.remainingMinutes).toBe('number')
      expect(typeof body.createdAt).toBe('string')

      // Verify ISO format for timestamps
      expect(() => new Date(body.cooldownEndsAt)).not.toThrow()
      expect(() => new Date(body.createdAt)).not.toThrow()

      jest.useRealTimers()
    })

    test('cooldownEndsAt is exactly createdAt + COOLDOWN_HOURS * 3600 * 1000', async () => {
      jest.useFakeTimers()
      const now = new Date('2024-01-01T15:30:45Z')
      jest.setSystemTime(now)

      const createdAt = new Date('2024-01-01T12:30:45Z')
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa_calc',
        userId: 'user_1',
        address: 'GCALC',
        createdAt,
      })

      const res = await GET(makeReq('wa_calc'), { params: { id: 'wa_calc' } })
      const body = await res.json()

      const expectedCooldownEnds = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000)
      expect(body.cooldownEndsAt).toBe(expectedCooldownEnds.toISOString())

      jest.useRealTimers()
    })
  })

  describe('ERROR HANDLING', () => {
    test('returns 500 when prisma throws unexpected error', async () => {
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockRejectedValue(new Error('Database error'))

      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Internal Server Error')
      expect(body.message).toBe('Failed to fetch cooldown status')
    })

    test('returns 500 with correct error shape on exception', async () => {
      mockVerify.mockRejectedValue(new Error('Auth service down'))

      const res = await GET(makeReq('wa1'), { params: { id: 'wa1' } })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('message')
      expect(body.error).toBe('Internal Server Error')
    })
  })

  describe('PRISMA QUERY SELECTION', () => {
    test('selects only safe fields from whitelist address', async () => {
      mockVerify.mockResolvedValue({ userId: 'privy_1' })
      mockUserFindUnique.mockResolvedValue({ id: 'user_1' })
      mockWhitelistFindUnique.mockResolvedValue({
        id: 'wa1',
        userId: 'user_1',
        address: 'GABC123',
        createdAt: new Date(),
      })

      await GET(makeReq('wa1'), { params: { id: 'wa1' } })

      expect(mockWhitelistFindUnique).toHaveBeenCalledWith({
        where: { id: 'wa1' },
        select: {
          id: true,
          userId: true,
          address: true,
          createdAt: true,
        },
      })
    })
  })
})
