import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('../../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
    status = 403
  },
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    reminderSettings: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))

import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { prisma } from '@/lib/db'
import { GET, PATCH } from '../preferences/route'

const mockedRequireScope = vi.mocked(requireScope)
const settingsDelegate = prisma.reminderSettings as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-b/notifications/preferences'
const AUTH = { userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] }

function makeGet() {
  return new NextRequest(BASE_URL, { headers: { authorization: 'Bearer token' } })
}

function makePatch(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/notifications/preferences', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
  })

  it('returns default preferences when no settings exist', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.invoicePaid).toBe(true)
    expect(body.invoiceOverdue).toBe(true)
    expect(body.securityAlert).toBe(true)
    expect(body.marketing).toBe(true)
  })

  it('returns stored preferences', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const prefs = { invoicePaid: false, invoiceOverdue: true, withdrawalCompleted: true, securityAlert: true, marketing: false }
    settingsDelegate.findUnique.mockResolvedValue({
      customMessage: JSON.stringify({ routesBNotificationPreferences: prefs }),
    })
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.invoicePaid).toBe(false)
    expect(body.marketing).toBe(false)
  })
})

describe('PATCH /api/routes-b/notifications/preferences', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await PATCH(makePatch({ marketing: false }))
    expect(res.status).toBe(401)
  })

  it('always enforces securityAlert=true', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue(null)
    settingsDelegate.create.mockResolvedValue({})
    const res = await PATCH(makePatch({ securityAlert: false, marketing: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.securityAlert).toBe(true)
  })

  it('updates preferences and persists', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue({ id: 'rs-1', customMessage: null })
    settingsDelegate.update.mockResolvedValue({})
    const res = await PATCH(makePatch({ marketing: false, invoicePaid: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.marketing).toBe(false)
    expect(body.invoicePaid).toBe(false)
    expect(settingsDelegate.update).toHaveBeenCalled()
  })
})
