import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, reminderSettings: { findUnique: vi.fn(), upsert: vi.fn() } },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedSettingsFind = vi.mocked(prisma.reminderSettings.findUnique)
const mockedSettingsUpsert = vi.mocked(prisma.reminderSettings.upsert)

function reqGET(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/reminder-settings', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

function reqPATCH(body: any, auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/reminder-settings', {
    method: 'PATCH',
    headers: auth ? { authorization: auth, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/reminder-settings', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(reqGET(''))).status).toBe(401)
  })

  it('returns 401 if user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(reqGET())).status).toBe(401)
  })

  it('returns settings if found', async () => {
    mockedSettingsFind.mockResolvedValue({ id: '1', onDueEnabled: true, beforeDueDays: [3], afterDueDays: [7] } as never)
    const res = await GET(reqGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings.onDueEnabled).toBe(true)
  })

  it('returns null settings if not found', async () => {
    mockedSettingsFind.mockResolvedValue(null as never)
    const res = await GET(reqGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings).toBeNull()
  })
})

describe('PATCH /api/routes-d/reminder-settings', () => {
  it('returns 401 without token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await PATCH(reqPATCH({}))).status).toBe(401)
  })

  it('validates sendDaysBefore limit', async () => {
    expect((await PATCH(reqPATCH({ sendDaysBefore: 50 }))).status).toBe(400)
  })

  it('validates sendDaysAfter limit', async () => {
    expect((await PATCH(reqPATCH({ sendDaysAfter: 100 }))).status).toBe(400)
  })

  it('upserts settings successfully', async () => {
    mockedSettingsUpsert.mockResolvedValue({ onDueEnabled: false, beforeDueDays: [2], afterDueDays: [5] } as never)
    const res = await PATCH(reqPATCH({ sendOnDueDate: false, sendDaysBefore: 2, sendDaysAfter: 5 }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.settings.sendOnDueDate).toBe(false)
    expect(json.settings.sendDaysBefore).toBe(2)
    expect(json.settings.sendDaysAfter).toBe(5)
  })
})
