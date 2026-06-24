import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emailTemplate: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PATCH } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const templateDelegate = prisma.emailTemplate as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

const TEMPLATE_ID = 'tmpl-1'
const BASE_URL = `http://localhost/api/routes-b/email-templates/${TEMPLATE_ID}`
const CLAIMS = { userId: 'privy-1' }
const USER = { id: 'user-1' }
const EXISTING_TEMPLATE = { id: TEMPLATE_ID, userId: 'user-1' }

function makePatch(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers: authHeader
      ? { authorization: authHeader, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PARAMS = { params: Promise.resolve({ id: TEMPLATE_ID }) }

describe('PATCH /api/routes-b/email-templates/[id]', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ name: 'New Name' }, null), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 404 when template does not exist', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(null)
    const res = await PATCH(makePatch({ name: 'New Name' }), PARAMS)
    expect(res.status).toBe(404)
  })

  it('returns 403 when template belongs to another user', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue({ id: TEMPLATE_ID, userId: 'other-user' })
    const res = await PATCH(makePatch({ name: 'New Name' }), PARAMS)
    expect(res.status).toBe(403)
  })

  it('returns 400 for invalid JSON', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const req = new NextRequest(BASE_URL, {
      method: 'PATCH',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await PATCH(req, PARAMS)
    expect(res.status).toBe(400)
  })

  it('returns 400 when no valid fields are provided', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const res = await PATCH(makePatch({}), PARAMS)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/no valid fields/i)
  })

  it('returns 400 for invalid template type', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const res = await PATCH(makePatch({ type: 'unknown' }), PARAMS)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/type/)
  })

  it('returns 400 for empty name', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const res = await PATCH(makePatch({ name: '   ' }), PARAMS)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/name/)
  })

  it('returns 400 when isDefault is not boolean', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const res = await PATCH(makePatch({ isDefault: 'yes' }), PARAMS)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/isDefault/)
  })

  it('updates allowed fields and returns 200', async () => {
    mockedVerify.mockResolvedValue(CLAIMS as never)
    userDelegate.findUnique.mockResolvedValue(USER)
    templateDelegate.findUnique.mockResolvedValue(EXISTING_TEMPLATE)
    const updated = {
      id: TEMPLATE_ID,
      name: 'Invoice Reminder',
      subject: 'Your invoice is due',
      body: 'Please pay your invoice',
      type: 'reminder',
      isDefault: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    }
    templateDelegate.update.mockResolvedValue(updated)
    const res = await PATCH(
      makePatch({ name: 'Invoice Reminder', subject: 'Your invoice is due', type: 'reminder' }),
      PARAMS,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template).toMatchObject({ id: TEMPLATE_ID, name: 'Invoice Reminder' })
    expect(templateDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEMPLATE_ID },
        data: expect.objectContaining({ name: 'Invoice Reminder', type: 'reminder' }),
      }),
    )
  })
})
