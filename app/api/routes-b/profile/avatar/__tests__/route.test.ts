import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUpdate = vi.mocked(prisma.user.update)

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/profile/avatar', {
    method: 'PATCH',
    headers: { authorization: 'Bearer token', ...headers },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/routes-b/profile/avatar', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
  })

  describe('happy path', () => {
    it('updates avatar URL successfully', async () => {
      mockedUpdate.mockResolvedValue({ avatarUrl: 'https://example.com/avatar.jpg' } as never)

      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' })
      const res = await PATCH(req)
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(json).toEqual({ avatarUrl: 'https://example.com/avatar.jpg' })
      expect(mockedUpdate).toHaveBeenCalledWith({
        where: { privyId: 'privy-123' },
        data: { avatarUrl: 'https://example.com/avatar.jpg' },
        select: { avatarUrl: true },
      })
    })

    it('sets avatar to null when null is provided', async () => {
      mockedUpdate.mockResolvedValue({ avatarUrl: null } as never)

      const req = makeRequest({ avatarUrl: null })
      const res = await PATCH(req)
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(json).toEqual({ avatarUrl: null })
      expect(mockedUpdate).toHaveBeenCalledWith({
        where: { privyId: 'privy-123' },
        data: { avatarUrl: null },
        select: { avatarUrl: true },
      })
    })

    it('includes requestId in response headers', async () => {
      mockedUpdate.mockResolvedValue({ avatarUrl: 'https://example.com/avatar.jpg' } as never)

      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' }, { 'x-request-id': 'req-123' })
      const res = await PATCH(req)
      expect(res.headers.get('X-Request-Id')).toBe('req-123')
    })

    it('generates requestId if not provided', async () => {
      mockedUpdate.mockResolvedValue({ avatarUrl: 'https://example.com/avatar.jpg' } as never)

      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' })
      const res = await PATCH(req)
      expect(res.headers.get('X-Request-Id')).toBeTruthy()
    })
  })

  describe('auth and validation', () => {
    it('returns 401 when auth token is missing', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/profile/avatar', {
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl: 'https://example.com/avatar.jpg' }),
      })
      const res = await PATCH(req)
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 401 when auth token is invalid', async () => {
      mockVerifyAuthToken.mockResolvedValueOnce(null)
      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' })
      const res = await PATCH(req)
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 400 when JSON body is invalid', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/profile/avatar', {
        method: 'PATCH',
        headers: { authorization: 'Bearer token' },
        body: 'invalid json',
      })
      const res = await PATCH(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid JSON body',
      })
    })

    it('returns 400 when avatarUrl is not a string or null', async () => {
      const req = makeRequest({ avatarUrl: 123 })
      const res = await PATCH(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'avatarUrl must be a string or null',
      })
    })

    it('returns 400 when avatarUrl exceeds 512 characters', async () => {
      const req = makeRequest({ avatarUrl: 'https://example.com/' + 'a'.repeat(500) })
      const res = await PATCH(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'avatarUrl must not exceed 512 characters',
      })
    })

    it('returns 400 when avatarUrl is not a valid HTTPS URL', async () => {
      const req = makeRequest({ avatarUrl: 'http://example.com/avatar.jpg' })
      const res = await PATCH(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'avatarUrl must be a valid HTTPS URL',
      })
    })

    it('returns 400 when avatarUrl is an invalid URL', async () => {
      const req = makeRequest({ avatarUrl: 'not-a-url' })
      const res = await PATCH(req)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'avatarUrl must be a valid HTTPS URL',
      })
    })

    it('accepts avatarUrl of exactly 512 characters', async () => {
      mockedUpdate.mockResolvedValue({ avatarUrl: 'https://example.com/' + 'a'.repeat(490) } as never)

      const url = 'https://example.com/' + 'a'.repeat(490)
      const req = makeRequest({ avatarUrl: url })
      const res = await PATCH(req)
      expect(res.status).toBe(200)
    })
  })

  describe('error handling', () => {
    it('returns structured error on unexpected error', async () => {
      mockedUpdate.mockRejectedValueOnce(new Error('Database connection failed'))
      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' })
      const res = await PATCH(req)
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'INTERNAL',
        message: 'Failed to update avatar',
      })
      expect(json.requestId).toBeTruthy()
    })

    it('includes requestId in error response', async () => {
      mockedUpdate.mockRejectedValueOnce(new Error('Database error'))
      const req = makeRequest({ avatarUrl: 'https://example.com/avatar.jpg' }, { 'x-request-id': 'error-req-456' })
      const res = await PATCH(req)
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.requestId).toBe('error-req-456')
    })
  })
})
