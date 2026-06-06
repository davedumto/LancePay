import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    reminderSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('../_lib/table-columns', () => ({ hasTableColumn: vi.fn().mockResolvedValue(false) }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedSettingsFind = vi.mocked(prisma.reminderSettings.findUnique)
const mockedSettingsUpsert = vi.mocked(prisma.reminderSettings.upsert)
const mockedExecuteRaw = vi.mocked(prisma.$executeRaw)

function makeRequest(method: 'GET' | 'PATCH' = 'GET', body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/reminder-settings', {
    method,
    headers: { authorization: 'Bearer token', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
}

const fakeUser = {
  id: 'user-uuid-123',
  privyId: 'privy-123',
}

const fakeSettings = {
  id: 'settings-123',
  enabled: true,
  beforeDueDays: [3],
  afterDueDays: [7],
  onDueEnabled: true,
}

describe('GET /api/routes-b/reminder-settings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mockedUserFind.mockResolvedValue(fakeUser as never)
  })

  describe('happy path', () => {
    it('returns reminder settings when they exist', async () => {
      mockedSettingsFind.mockResolvedValue(fakeSettings as never)

      const res = await GET(makeRequest())
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(json.settings).toMatchObject({
        id: 'settings-123',
        enabled: true,
        firstReminderDays: 3,
        secondReminderDays: 7,
        sendOnDueDate: true,
      })
    })

    it('returns null when settings do not exist', async () => {
      mockedSettingsFind.mockResolvedValue(null)

      const res = await GET(makeRequest())
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(json.settings).toBeNull()
    })

    it('includes requestId in response headers', async () => {
      mockedSettingsFind.mockResolvedValue(fakeSettings as never)

      const res = await GET(makeRequest('GET', undefined, { 'x-request-id': 'req-123' }))
      expect(res.headers.get('X-Request-Id')).toBe('req-123')
    })

    it('generates requestId if not provided', async () => {
      mockedSettingsFind.mockResolvedValue(fakeSettings as never)

      const res = await GET(makeRequest())
      expect(res.headers.get('X-Request-Id')).toBeTruthy()
    })
  })

  describe('auth and error handling', () => {
    it('returns 401 when auth token is missing', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/reminder-settings', { method: 'GET' })
      const res = await GET(req)
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 401 when auth token is invalid', async () => {
      mockVerifyAuthToken.mockResolvedValueOnce(null)
      const res = await GET(makeRequest())
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 500 on unexpected error', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database connection failed'))
      const res = await GET(makeRequest())
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'INTERNAL',
        message: 'Failed to get reminder settings',
      })
      expect(json.requestId).toBeTruthy()
    })

    it('includes requestId in error response', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database error'))
      const res = await GET(makeRequest('GET', undefined, { 'x-request-id': 'error-req-456' }))
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.requestId).toBe('error-req-456')
    })
  })
})

describe('PATCH /api/routes-b/reminder-settings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    mockedUserFind.mockResolvedValue(fakeUser as never)
    mockedSettingsFind.mockResolvedValue(fakeSettings as never)
    mockedSettingsUpsert.mockResolvedValue(fakeSettings as never)
  })

  describe('happy path', () => {
    it('updates reminder settings successfully', async () => {
      const res = await PATCH(makeRequest('PATCH', { enabled: false }))
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(json.settings).toMatchObject({
        id: 'settings-123',
        enabled: true,
      })
    })

    it('updates firstReminderDays', async () => {
      const res = await PATCH(makeRequest('PATCH', { firstReminderDays: 5 }))
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(mockedSettingsUpsert).toHaveBeenCalled()
    })

    it('updates secondReminderDays', async () => {
      const res = await PATCH(makeRequest('PATCH', { secondReminderDays: 10 }))
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(mockedSettingsUpsert).toHaveBeenCalled()
    })

    it('updates sendOnDueDate', async () => {
      const res = await PATCH(makeRequest('PATCH', { sendOnDueDate: false }))
      const json = await res.json()

      expect(res.status).toBe(200)
      expect(mockedSettingsUpsert).toHaveBeenCalled()
    })

    it('includes requestId in response headers', async () => {
      const res = await PATCH(makeRequest('PATCH', { enabled: false }, { 'x-request-id': 'req-123' }))
      expect(res.headers.get('X-Request-Id')).toBe('req-123')
    })

    it('generates requestId if not provided', async () => {
      const res = await PATCH(makeRequest('PATCH', { enabled: false }))
      expect(res.headers.get('X-Request-Id')).toBeTruthy()
    })
  })

  describe('auth and validation', () => {
    it('returns 401 when auth token is missing', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/reminder-settings', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
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
      const res = await PATCH(makeRequest('PATCH', { enabled: false }))
      expect(res.status).toBe(401)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })
    })

    it('returns 422 when JSON body is invalid', async () => {
      const req = new NextRequest('http://localhost/api/routes-b/reminder-settings', {
        method: 'PATCH',
        headers: { authorization: 'Bearer token' },
        body: 'invalid json',
      })
      const res = await PATCH(req)
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid request body',
      })
    })

    it('returns 422 when firstReminderDays is invalid', async () => {
      const res = await PATCH(makeRequest('PATCH', { firstReminderDays: 0 }))
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid payload',
      })
    })

    it('returns 422 when secondReminderDays is invalid', async () => {
      const res = await PATCH(makeRequest('PATCH', { secondReminderDays: 0 }))
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid payload',
      })
    })

    it('returns 422 when secondReminderDays <= firstReminderDays', async () => {
      const res = await PATCH(makeRequest('PATCH', { firstReminderDays: 5, secondReminderDays: 5 }))
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid reminder settings payload',
      })
      expect(json.fields).toMatchObject({
        secondReminderDays: 'Must be greater than firstReminderDays',
      })
    })

    it('returns 422 when secondReminderDays < firstReminderDays', async () => {
      const res = await PATCH(makeRequest('PATCH', { firstReminderDays: 10, secondReminderDays: 5 }))
      expect(res.status).toBe(422)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid reminder settings payload',
      })
    })
  })

  describe('error handling', () => {
    it('returns structured error on unexpected error', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database connection failed'))
      const res = await PATCH(makeRequest('PATCH', { enabled: false }))
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatchObject({
        code: 'INTERNAL',
        message: 'Failed to update reminder settings',
      })
      expect(json.requestId).toBeTruthy()
    })

    it('includes requestId in error response', async () => {
      mockedUserFind.mockRejectedValueOnce(new Error('Database error'))
      const res = await PATCH(makeRequest('PATCH', { enabled: false }, { 'x-request-id': 'error-req-456' }))
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.requestId).toBe('error-req-456')
    })
  })
})
