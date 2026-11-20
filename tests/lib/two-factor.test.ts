import { beforeEach, describe, expect, it, vi } from 'vitest'
import speakeasy from 'speakeasy'
import { encrypt } from '@/lib/crypto'

const updateManyMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { updateMany: updateManyMock },
  },
}))

import { verifyTwoFactorForRequest } from '@/lib/two-factor'

const BASE32_SECRET = 'JBSWY3DPEHPK3PXP'
const USER = {
  id: 'user-1',
  twoFactorEnabled: true,
  twoFactorSecret: encrypt(BASE32_SECRET),
  lastTotpStep: null as number | null,
}

function totpAt(offsetSteps = 0): string {
  const time = Math.floor(Date.now() / 1000) + offsetSteps * 30
  return speakeasy.totp({ secret: BASE32_SECRET, encoding: 'base32', time })
}

describe('verifyTwoFactorForRequest replay protection (#1837)', () => {
  let storedStep: number | null

  beforeEach(() => {
    vi.clearAllMocks()
    storedStep = null
    // Emulate the conditional write: succeeds only when the claimed step is
    // newer than the stored lastTotpStep.
    updateManyMock.mockImplementation(async ({ data }: { data: { lastTotpStep: number } }) => {
      if (storedStep === null || storedStep < data.lastTotpStep) {
        storedStep = data.lastTotpStep
        return { count: 1 }
      }
      return { count: 0 }
    })
  })

  it('accepts a valid code and persists its time step', async () => {
    const result = await verifyTwoFactorForRequest(USER, totpAt())
    expect(result).toEqual({ ok: true })
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'user-1' }),
        data: expect.objectContaining({ lastTotpStep: expect.any(Number) }),
      })
    )
    expect(storedStep).not.toBeNull()
  })

  it('rejects replaying the same code inside its validity window', async () => {
    const code = totpAt()
    await expect(verifyTwoFactorForRequest(USER, code)).resolves.toEqual({ ok: true })
    await expect(verifyTwoFactorForRequest(USER, code)).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'Invalid 2FA code',
    })
  })

  it('rejects a code whose step is not newer than the stored step', async () => {
    const code = totpAt()
    await verifyTwoFactorForRequest(USER, code)
    // Simulate a stored step equal to or ahead of the code's step
    storedStep = (storedStep ?? 0) + 1
    await expect(verifyTwoFactorForRequest(USER, code)).resolves.toMatchObject({ ok: false })
  })

  it('accepts the next time step code', async () => {
    await verifyTwoFactorForRequest(USER, totpAt())
    const result = await verifyTwoFactorForRequest(USER, totpAt(1))
    expect(result).toEqual({ ok: true })
  })

  it('allows only one of two concurrent requests presenting the same code', async () => {
    const code = totpAt()
    const [first, second] = await Promise.all([
      verifyTwoFactorForRequest(USER, code),
      verifyTwoFactorForRequest(USER, code),
    ])
    const results = [first, second]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toHaveLength(1)
  })

  it('rejects an invalid code without touching storage', async () => {
    const result = await verifyTwoFactorForRequest(USER, '000000')
    expect(result).toEqual({ ok: false, status: 401, error: 'Invalid 2FA code' })
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('returns ok when 2FA is disabled and never writes', async () => {
    const result = await verifyTwoFactorForRequest(
      { id: 'user-1', twoFactorEnabled: false, twoFactorSecret: null },
      undefined
    )
    expect(result).toEqual({ ok: true })
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('requires a code and a configured secret', async () => {
    await expect(
      verifyTwoFactorForRequest(USER, undefined)
    ).resolves.toEqual({ ok: false, status: 401, error: '2FA code required' })
    await expect(
      verifyTwoFactorForRequest({ ...USER, twoFactorSecret: null }, '123456')
    ).resolves.toEqual({ ok: false, status: 401, error: '2FA is misconfigured; contact support' })
  })
})
