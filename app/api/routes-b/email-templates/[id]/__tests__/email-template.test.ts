import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('../../../_lib/authz', () => ({
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

import { requireScope, RoutesBForbiddenError } from '../../../_lib/authz'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedRequireScope = vi.mocked(requireScope)
const settingsDelegate = prisma.reminderSettings as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = (id: string) => `http://localhost/api/routes-b/email-templates/${id}`
const AUTH = { userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] }

function makePatch(id: string, body: unknown) {
  return new NextRequest(BASE_URL(id), {
    method: 'PATCH',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function params(id: string) {
  return { params: { id } }
}

describe('PATCH /api/routes-b/email-templates/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedRequireScope.mockRejectedValue(new RoutesBForbiddenError('missing'))
    const res = await PATCH(makePatch('invoice_sent', { subject: 'New' }), params('invoice_sent'))
    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown template id', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await PATCH(makePatch('not_a_template', { subject: 'x' }), params('not_a_template'))
    expect(res.status).toBe(404)
  })

  it('returns 400 when no fields are provided', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await PATCH(makePatch('invoice_sent', {}), params('invoice_sent'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when subject exceeds 200 characters', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await PATCH(makePatch('invoice_sent', { subject: 'x'.repeat(201) }), params('invoice_sent'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when enabled is not a boolean', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    const res = await PATCH(makePatch('invoice_sent', { enabled: 'yes' }), params('invoice_sent'))
    expect(res.status).toBe(400)
  })

  it('creates settings and updates a template for a new user', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue(null)
    settingsDelegate.create.mockResolvedValue({})
    const res = await PATCH(makePatch('invoice_sent', { subject: 'Your invoice', enabled: false }), params('invoice_sent'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template).toMatchObject({ id: 'invoice_sent', subject: 'Your invoice', enabled: false })
    expect(settingsDelegate.create).toHaveBeenCalled()
  })

  it('updates an existing settings record', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue({ id: 'rs-1', customMessage: null })
    settingsDelegate.update.mockResolvedValue({})
    const res = await PATCH(makePatch('payment_received', { subject: 'You got paid!' }), params('payment_received'))
    expect(res.status).toBe(200)
    expect(settingsDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rs-1' } }),
    )
  })

  it('also accepts body-only and enabled-only patches', async () => {
    mockedRequireScope.mockResolvedValue(AUTH)
    settingsDelegate.findUnique.mockResolvedValue({ id: 'rs-1', customMessage: null })
    settingsDelegate.update.mockResolvedValue({})
    const res = await PATCH(makePatch('invoice_overdue', { enabled: false }), params('invoice_overdue'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template.enabled).toBe(false)
  })
})
