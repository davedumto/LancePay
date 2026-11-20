import { describe, it, expect, beforeEach, vi } from 'vitest'

const apiKeyFindUnique = vi.fn()
const apiKeyUpdate = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    apiKey: {
      findUnique: (...args: any[]) => apiKeyFindUnique(...args),
      update: (...args: any[]) => apiKeyUpdate(...args),
    },
  },
}))

vi.mock('@/lib/crypto', () => ({
  hashToken: (raw: string) => `hashed:${raw}`,
}))

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    verifyAuthToken = vi.fn()
  },
}))

import { verifyApiKey } from '@/lib/auth'

const baseKey = {
  id: 'key_1',
  userId: 'user_1',
  name: 'Test Key',
  isActive: true,
  deactivatesAt: null,
  lastUsedAt: null as Date | null,
  createdAt: new Date('2026-01-01'),
}

describe('verifyApiKey lastUsedAt throttling (#1887)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiKeyUpdate.mockResolvedValue({})
  })

  it('writes lastUsedAt when the stored value is null', async () => {
    apiKeyFindUnique.mockResolvedValue({ ...baseKey, lastUsedAt: null })
    const result = await verifyApiKey('raw_key')

    expect(result?.userId).toBe('user_1')
    expect(apiKeyUpdate).toHaveBeenCalledTimes(1)
    expect(apiKeyUpdate).toHaveBeenCalledWith({
      where: { id: 'key_1' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it('does not rewrite a recent lastUsedAt', async () => {
    apiKeyFindUnique.mockResolvedValue({
      ...baseKey,
      lastUsedAt: new Date(Date.now() - 5_000), // 5s ago < 60s interval
    })
    const result = await verifyApiKey('raw_key')

    expect(result?.userId).toBe('user_1')
    expect(apiKeyUpdate).not.toHaveBeenCalled()
  })

  it('rewrites lastUsedAt when it is older than the interval', async () => {
    apiKeyFindUnique.mockResolvedValue({
      ...baseKey,
      lastUsedAt: new Date(Date.now() - 120_000), // 2min ago > 60s interval
    })
    await verifyApiKey('raw_key')

    expect(apiKeyUpdate).toHaveBeenCalledTimes(1)
  })

  it('still returns the key record when the update fails', async () => {
    apiKeyFindUnique.mockResolvedValue({ ...baseKey, lastUsedAt: null })
    apiKeyUpdate.mockRejectedValue(new Error('db down'))

    const result = await verifyApiKey('raw_key')
    expect(result?.userId).toBe('user_1')
    expect(result?.apiKey.id).toBe('key_1')
  })

  it('returns null for missing, inactive and grace-expired keys', async () => {
    apiKeyFindUnique.mockResolvedValue(null)
    expect(await verifyApiKey('raw_key')).toBeNull()

    apiKeyFindUnique.mockResolvedValue({ ...baseKey, isActive: false })
    expect(await verifyApiKey('raw_key')).toBeNull()

    apiKeyFindUnique.mockResolvedValue({
      ...baseKey,
      deactivatesAt: new Date(Date.now() - 1000),
    })
    expect(await verifyApiKey('raw_key')).toBeNull()
    expect(apiKeyUpdate).not.toHaveBeenCalled()
  })
})
