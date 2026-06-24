import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    notificationPreference: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const prefDelegate = prisma.notificationPreference as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/notifications/preferences'
const CLAIMS = { userId: 'privy-1' }
const USER = { id: 'user-1' }
const STORED_PREFS = {
  userId: 'user-1',
  invoicePaid: true,
  invoiceOverdue: true,
  paymentFailed: false,
  newMessage: true,
  disputeOpened: true,
  channels: ['email'],
}

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePatch(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: authHeader
      ? { authorization: authHeader, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/notifications/preferences', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns stored preferences when they exist', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    prefDelegate.findUnique.mockResolvedValue(STORED_PREFS)
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preferences).toMatchObject({ invoicePaid: true, paymentFailed: false })
  })

  it('returns defaults when no preferences are stored', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    prefDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preferences.invoicePaid).toBe(true)
    expect(body.preferences.channels).toContain('email')
  })
})

describe('PATCH /api/routes-b/notifications/preferences', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ invoicePaid: false }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const req = new NextRequest(BASE_URL, {
      method: 'PATCH',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when a boolean field has wrong type', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await PATCH(makePatch({ invoicePaid: 'yes' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invoicePaid/)
  })

  it('returns 400 for invalid channel value', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await PATCH(makePatch({ channels: ['pigeon'] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/channels/)
  })

  it('returns 400 when channels is not an array', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const res = await PATCH(makePatch({ channels: 'email' }))
    expect(res.status).toBe(400)
  })

  it('updates preferences and returns 200', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    const updated = { ...STORED_PREFS, invoicePaid: false, channels: ['email', 'sms'] }
    prefDelegate.upsert.mockResolvedValue(updated)
    const res = await PATCH(makePatch({ invoicePaid: false, channels: ['email', 'sms'] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preferences.invoicePaid).toBe(false)
    expect(body.preferences.channels).toEqual(['email', 'sms'])
    expect(prefDelegate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        update: expect.objectContaining({ invoicePaid: false }),
      }),
    )
  })

  it('upserts preferences when none previously existed', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    prefDelegate.upsert.mockResolvedValue({ ...STORED_PREFS, paymentFailed: true })
    const res = await PATCH(makePatch({ paymentFailed: true }))
    expect(res.status).toBe(200)
    expect(prefDelegate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ userId: 'user-1' }) }),
    )
  })
})
