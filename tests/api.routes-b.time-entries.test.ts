import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const timeEntryFindFirst = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    timeEntry: { findFirst: timeEntryFindFirst },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/time-entries/test-id'

function makeRequest() {
  return new NextRequest(BASE_URL, {
    headers: { authorization: 'Bearer token' },
  })
}

function makeParams(id: string = 'test-id') {
  return Promise.resolve({ id })
}

describe('GET /api/routes-b/time-entries/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    const res = await GET(makeRequest(), { params: makeParams() })
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    const res = await GET(makeRequest(), { params: makeParams() })
    expect(res.status).toBe(404)
  })

  it('returns 404 when time entry is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    timeEntryFindFirst.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    const res = await GET(makeRequest(), { params: makeParams() })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/Time entry not found/)
  })

  it('returns time entry when found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const mockTimeEntry = {
      id: 'te_1',
      userId: 'user_1',
      description: 'Test work',
      hours: 2.5,
      createdAt: new Date('2026-01-01'),
    }
    timeEntryFindFirst.mockResolvedValue(mockTimeEntry)
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    const res = await GET(makeRequest(), { params: makeParams() })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('te_1')
    expect(json.description).toBe('Test work')
  })

  it('queries time entry with user ownership check', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    timeEntryFindFirst.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    await GET(makeRequest(), { params: makeParams() })
    expect(timeEntryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'test-id',
          userId: 'user_1',
        },
      }),
    )
  })

  it('returns 500 on database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    timeEntryFindFirst.mockRejectedValue(new Error('Database error'))
    const { GET } = await import('@/app/api/routes-b/time-entries/[id]/route')
    const res = await GET(makeRequest(), { params: makeParams() })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatch(/Failed to fetch time entry/)
    expect(loggerError).toHaveBeenCalled()
  })
})
