import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  loginNotificationSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  GET,
  PATCH,
  registerPendingLoginNotification,
  shouldSendNewDeviceNotification,
  resetLoginNotificationRuntimeState,
} from './route'

describe('GET, PATCH /api/settings/login-notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLoginNotificationRuntimeState()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'did:privy:user_ln_1',
      email: 'account@lancepay.io',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user_ln_1',
      email: 'account@lancepay.io',
    })
  })

  it('upserts on first PATCH since the row is one-per-user', async () => {
    mockPrisma.loginNotificationSettings.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'lns_1',
        ...create,
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
        updatedAt: new Date('2026-06-05T10:00:00.000Z'),
      }),
    )

    const req = new NextRequest(
      'http://localhost/api/settings/login-notifications',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notifyOnNewDevice: true,
          notifyEmail: 'security-alerts@lancepay.io',
        }),
      },
    )

    const res = await PATCH(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.loginNotificationSettings.upsert).toHaveBeenCalledWith({
      where: { userId: 'user_ln_1' },
      update: {
        notifyOnNewDevice: true,
        notifyEmail: 'security-alerts@lancepay.io',
      },
      create: {
        userId: 'user_ln_1',
        notifyOnNewDevice: true,
        notifyEmail: 'security-alerts@lancepay.io',
      },
    })

    expect(body.settings).toMatchObject({
      id: 'lns_1',
      userId: 'user_ln_1',
      notifyOnNewDevice: true,
      notifyEmail: 'security-alerts@lancepay.io',
      effectiveNotifyEmail: 'security-alerts@lancepay.io',
    })
  })

  it('validates notifyEmail format when supplied and falls back to account email when notifyEmail is null', async () => {
    const invalidEmailReq = new NextRequest(
      'http://localhost/api/settings/login-notifications',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notifyEmail: 'not-an-email-address',
        }),
      },
    )

    const invalidRes = await PATCH(invalidEmailReq)
    expect(invalidRes.status).toBe(400)
    const invalidBody = await invalidRes.json()
    expect(invalidBody.code).toBe('INVALID_NOTIFY_EMAIL')
    expect(mockPrisma.loginNotificationSettings.upsert).not.toHaveBeenCalled()

    // When notifyEmail is null, effectiveNotifyEmail falls back to account email
    mockPrisma.loginNotificationSettings.findUnique.mockResolvedValue({
      id: 'lns_1',
      userId: 'user_ln_1',
      notifyOnNewDevice: true,
      notifyEmail: null,
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:05:00.000Z'),
    })

    const getReq = new NextRequest(
      'http://localhost/api/settings/login-notifications',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.settings.notifyEmail).toBeNull()
    expect(getBody.settings.effectiveNotifyEmail).toBe('account@lancepay.io')
  })

  it('takes effect immediately for any login attempt in progress when notifyOnNewDevice is set to false', async () => {
    // Simulate a login attempt currently in progress for user_ln_1
    const inFlightController = registerPendingLoginNotification('user_ln_1')
    expect(inFlightController.signal.aborted).toBe(false)

    mockPrisma.loginNotificationSettings.upsert.mockResolvedValue({
      id: 'lns_1',
      userId: 'user_ln_1',
      notifyOnNewDevice: false,
      notifyEmail: null,
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:10:00.000Z'),
    })

    const patchReq = new NextRequest(
      'http://localhost/api/settings/login-notifications',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notifyOnNewDevice: false,
        }),
      },
    )

    const patchRes = await PATCH(patchReq)
    expect(patchRes.status).toBe(200)
    const patchBody = await patchRes.json()

    expect(patchBody.settings.notifyOnNewDevice).toBe(false)
    expect(patchBody.cancelledInFlightLogins).toBe(1)

    // The in-progress login notification is immediately aborted and shouldSendNewDeviceNotification returns false
    expect(inFlightController.signal.aborted).toBe(true)
    expect(
      await shouldSendNewDeviceNotification(
        'user_ln_1',
        inFlightController.signal,
      ),
    ).toBe(false)
    expect(await shouldSendNewDeviceNotification('user_ln_1')).toBe(false)
  })
})
