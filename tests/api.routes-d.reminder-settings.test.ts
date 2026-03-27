import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const reminderFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    reminderSettings: { findUnique: reminderFindUnique },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/reminder-settings'

function makeRequest() {
  return new NextRequest(BASE_URL, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-d/reminder-settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/reminder-settings/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when no authorization header is present', async () => {
    const { GET } = await import('@/app/api/routes-d/reminder-settings/route')
    const res = await GET(new NextRequest(BASE_URL))
    expect(res.status).toBe(401)
  })

  it('returns { settings: null } when no settings exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    reminderFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/reminder-settings/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ settings: null })
  })

  it('returns settings when they exist', async () => {
    const settings = {
      id: 'rs_1',
      userId: 'user_1',
      enabled: true,
      beforeDueDays: [3, 1],
      onDueEnabled: true,
      afterDueDays: [1, 3, 7],
      customMessage: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    }
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    reminderFindUnique.mockResolvedValue(settings)
    const { GET } = await import('@/app/api/routes-d/reminder-settings/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings.id).toBe('rs_1')
    expect(json.settings.enabled).toBe(true)
    expect(json.settings.beforeDueDays).toEqual([3, 1])
    expect(json.settings.afterDueDays).toEqual([1, 3, 7])
    expect(json.settings.customMessage).toBeNull()
  })
})
