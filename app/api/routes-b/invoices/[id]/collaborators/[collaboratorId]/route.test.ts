import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PATCH } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    invoiceCollaborator: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'owner-1'
const mockPrivyId = 'privy-owner-1'
const invoiceId = 'inv-1'
const collaboratorId = 'collab-1'
const readAt = '2026-06-20T10:00:00.000Z'
const params = { id: invoiceId, collaboratorId }

function makeRequest(body: unknown, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(
    `http://localhost/api/routes-b/invoices/${invoiceId}/collaborators/${collaboratorId}`,
    { method: 'PATCH', headers, body: JSON.stringify(body) },
  )
}

function freshRow(overrides: Record<string, unknown> = {}) {
  return {
    id: collaboratorId,
    invoiceId,
    subContractorId: 'sub-1',
    role: 'editor',
    sharePercentage: { toString: () => '25.00' },
    payoutStatus: 'pending',
    paymentSource: 'payment',
    createdAt: new Date(readAt),
    updatedAt: new Date('2026-06-20T11:00:00.000Z'),
    ...overrides,
  }
}

describe('PATCH /api/routes-b/invoices/[id]/collaborators/[collaboratorId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: invoiceId } as never)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
    const res = await PATCH(makeRequest({ role: 'editor', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(401)
    expect(prisma.invoiceCollaborator.updateMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the caller does not own the invoice', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null as never)
    const res = await PATCH(makeRequest({ role: 'editor', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(404)
    expect(prisma.invoiceCollaborator.updateMany).not.toHaveBeenCalled()
  })

  it('rejects an invalid role', async () => {
    const res = await PATCH(makeRequest({ role: 'superuser', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(400)
  })

  it('requires expectedUpdatedAt', async () => {
    const res = await PATCH(makeRequest({ role: 'editor' }), { params })
    expect(res.status).toBe(400)
  })

  it('updates the role and returns the fresh row on the happy path', async () => {
    vi.mocked(prisma.invoiceCollaborator.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.invoiceCollaborator.findFirst).mockResolvedValue(freshRow() as never)

    const res = await PATCH(makeRequest({ role: 'editor', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.collaborator.role).toBe('editor')
    expect(data.collaborator.updatedAt).toBe('2026-06-20T11:00:00.000Z')
    expect(prisma.invoiceCollaborator.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: collaboratorId, invoiceId, updatedAt: new Date(readAt) },
        data: { role: 'editor' },
      }),
    )
  })

  it('returns 409 when the row changed since it was read', async () => {
    vi.mocked(prisma.invoiceCollaborator.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.invoiceCollaborator.findFirst).mockResolvedValue({
      id: collaboratorId,
      updatedAt: new Date('2026-06-20T12:00:00.000Z'),
    } as never)

    const res = await PATCH(makeRequest({ role: 'editor', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.currentUpdatedAt).toBe('2026-06-20T12:00:00.000Z')
  })

  it('returns 404 when the collaborator does not exist', async () => {
    vi.mocked(prisma.invoiceCollaborator.updateMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(prisma.invoiceCollaborator.findFirst).mockResolvedValue(null as never)

    const res = await PATCH(makeRequest({ role: 'editor', expectedUpdatedAt: readAt }), { params })
    expect(res.status).toBe(404)
  })
})
