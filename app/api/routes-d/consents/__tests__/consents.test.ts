import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    reminderSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const settingsDelegate = prisma.reminderSettings as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-d/consents'

function makeGet(authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePatch(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: authHeader ? { authorization: authHeader, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-d/consents', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
  })

  it('returns default consents when no record exists', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    settingsDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.consents).toMatchObject({
      marketing_emails: false,
      data_analytics: false,
      third_party_sharing: false,
      push_notifications: false,
    })
  })

  it('returns stored consents when a record exists', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    settingsDelegate.findUnique.mockResolvedValue({
      id: 'rs-1',
      consents: { marketing_emails: true, data_analytics: false, third_party_sharing: false, push_notifications: true },
    })
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.consents.marketing_emails).toBe(true)
    expect(body.consents.push_notifications).toBe(true)
    expect(body.consents.data_analytics).toBe(false)
  })
})

describe('PATCH /api/routes-d/consents', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ marketing_emails: true }, null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when no consent keys are provided', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await PATCH(makePatch({}))
    expect(res.status).toBe(400)
  })

  it('returns 400 when a consent value is not a boolean', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await PATCH(makePatch({ marketing_emails: 'yes' }))
    expect(res.status).toBe(400)
  })

  it('upserts consents and returns updated values', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy_1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    settingsDelegate.upsert.mockResolvedValue({})
    const res = await PATCH(makePatch({ marketing_emails: true, push_notifications: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.consents.marketing_emails).toBe(true)
    expect(body.consents.push_notifications).toBe(false)
    expect(settingsDelegate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    )
  })
})
