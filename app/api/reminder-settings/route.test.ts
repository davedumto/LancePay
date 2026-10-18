import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockSettingsFindUnique = vi.fn()
const mockSettingsUpsert = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    reminderSettings: {
      findUnique: (...args: unknown[]) => mockSettingsFindUnique(...args),
      upsert: (...args: unknown[]) => mockSettingsUpsert(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, PATCH, DEFAULT_REMINDER_SETTINGS } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'GET',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Reminder Settings API (/api/reminder-settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('returns the current effective settings on GET, including defaults if no row exists yet', async () => {
    mockSettingsFindUnique.mockResolvedValue(null)

    const req = makeRequest('http://localhost/api/reminder-settings', {
      method: 'GET',
      token: 'valid-token',
    })
    const res = await GET(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.reminderSettings.userId).toBe('user-1')
    expect(json.reminderSettings.enabled).toBe(true)
    expect(json.reminderSettings.beforeDueDays).toEqual(
      DEFAULT_REMINDER_SETTINGS.beforeDueDays,
    )
    expect(json.reminderSettings.onDueEnabled).toBe(true)
    expect(json.reminderSettings.afterDueDays).toEqual(
      DEFAULT_REMINDER_SETTINGS.afterDueDays,
    )
    expect(json.reminderSettings.isDefault).toBe(true)
  })

  it('validates that beforeDueDays and afterDueDays arrays contain only non-negative integers', async () => {
    const reqNegBefore = makeRequest('http://localhost/api/reminder-settings', {
      method: 'PATCH',
      token: 'valid-token',
      body: { beforeDueDays: [3, -1] },
    })
    const resNegBefore = await PATCH(reqNegBefore)
    expect(resNegBefore.status).toBe(400)
    const jsonNegBefore = await resNegBefore.json()
    expect(jsonNegBefore.code).toBe('INVALID_BEFORE_DUE_DAYS')

    const reqFloatAfter = makeRequest(
      'http://localhost/api/reminder-settings',
      {
        method: 'PATCH',
        token: 'valid-token',
        body: { afterDueDays: [1, 2.5] },
      },
    )
    const resFloatAfter = await PATCH(reqFloatAfter)
    expect(resFloatAfter.status).toBe(400)
    const jsonFloatAfter = await resFloatAfter.json()
    expect(jsonFloatAfter.code).toBe('INVALID_AFTER_DUE_DAYS')

    expect(mockSettingsUpsert).not.toHaveBeenCalled()
  })

  it('upserts on first PATCH rather than requiring a separate creation step', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockSettingsUpsert.mockImplementation(async ({ create }: any) => ({
      id: 'rs-1',
      ...create,
      createdAt: now,
      updatedAt: now,
    }))

    const req = makeRequest('http://localhost/api/reminder-settings', {
      method: 'PATCH',
      token: 'valid-token',
      body: {
        beforeDueDays: [5, 2, 0],
        afterDueDays: [1, 7, 14],
        customMessage: 'Please remit payment at your earliest convenience.',
      },
    })

    const res = await PATCH(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.reminderSettings.id).toBe('rs-1')
    expect(json.reminderSettings.beforeDueDays).toEqual([5, 2, 0])
    expect(json.reminderSettings.afterDueDays).toEqual([1, 7, 14])
    expect(json.reminderSettings.customMessage).toBe(
      'Please remit payment at your earliest convenience.',
    )
    expect(json.reminderSettings.isDefault).toBe(false)

    expect(mockSettingsUpsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        enabled: true,
        beforeDueDays: [5, 2, 0],
        onDueEnabled: true,
        afterDueDays: [1, 7, 14],
        customMessage: 'Please remit payment at your earliest convenience.',
      },
      update: {
        beforeDueDays: [5, 2, 0],
        afterDueDays: [1, 7, 14],
        customMessage: 'Please remit payment at your earliest convenience.',
      },
    })
  })
})
