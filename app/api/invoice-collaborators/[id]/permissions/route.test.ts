import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoiceCollaborator: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockClaims = { userId: 'privy-1' }

function collaborator(overrides: Record<string, unknown> = {}) {
  return {
    id: 'collab-1',
    invoiceId: 'inv-1',
    subContractorId: 'sub-1',
    role: 'editor',
    invoice: { id: 'inv-1', userId: 'owner-1' },
    ...overrides,
  }
}

function makeRequest(): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest('http://localhost/api/invoice-collaborators/collab-1/permissions', {
    headers: { authorization: 'Bearer token' },
  })
  return [req, { params: Promise.resolve({ id: 'collab-1' }) }]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.invoiceCollaborator.findUnique).mockResolvedValue(collaborator() as any)
})

describe('GET /api/invoice-collaborators/[id]/permissions', () => {
  it('resolves editor permissions for the invoice owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1' } as any)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.role).toBe('editor')
    expect(data.permissions).toEqual({ canEdit: true, canComment: true, canDelete: false })
  })

  it('resolves permissions for the collaborator themselves', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'sub-1' } as any)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
  })

  it('maps the admin role to full permissions', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1' } as any)
    vi.mocked(prisma.invoiceCollaborator.findUnique).mockResolvedValue(collaborator({ role: 'admin' }) as any)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    const data = await res.json()
    expect(data.permissions).toEqual({ canEdit: true, canComment: true, canDelete: true })
  })

  it('defaults to the most restrictive set for an unrecognized role', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1' } as any)
    vi.mocked(prisma.invoiceCollaborator.findUnique).mockResolvedValue(collaborator({ role: 'superuser' }) as any)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    const data = await res.json()
    expect(data.permissions).toEqual({ canEdit: false, canComment: false, canDelete: false })
  })

  it('returns 403 when the caller is neither the owner nor the collaborator', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'stranger-1' } as any)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    expect(res.status).toBe(403)
  })

  it('returns 404 when the collaborator does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1' } as any)
    vi.mocked(prisma.invoiceCollaborator.findUnique).mockResolvedValue(null)
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const req = new NextRequest('http://localhost/api/invoice-collaborators/collab-1/permissions')
    const res = await GET(req, { params: Promise.resolve({ id: 'collab-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'owner-1' } as any)
    vi.mocked(prisma.invoiceCollaborator.findUnique).mockRejectedValue(new Error('DB error'))
    const [req, ctx] = makeRequest()
    const res = await GET(req, ctx)
    expect(res.status).toBe(500)
  })
})
