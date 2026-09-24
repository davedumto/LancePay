import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    teamMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    invoiceCollaborator: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ownerUser = { id: 'owner-1', privyId: 'privy-owner' }
const mockClaims = { userId: 'privy-owner' }

// A plain editor member belonging to owner-1's team.
const editorMember = {
  id: 'tm-1',
  ownerId: 'owner-1',
  memberId: 'member-user-1',
  email: 'editor@example.com',
  role: 'editor',
  status: 'active',
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/team-members/tm-1', {
    method: 'DELETE',
    headers: { authorization: 'Bearer token' },
  })
}

const paramsFor = (id = 'tm-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(ownerUser as any)
  vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(editorMember as any)
  vi.mocked(prisma.teamMember.update).mockResolvedValue({
    ...editorMember,
    status: 'removed',
  } as any)
  vi.mocked(prisma.invoiceCollaborator.updateMany).mockResolvedValue({ count: 2 } as any)
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(prisma))
})

describe('DELETE /api/team-members/[id]', () => {
  it('removes the member and flags their open collaborations (happy path)', async () => {
    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.teamMember.status).toBe('removed')
    expect(data.reassignedCollaborations).toBe(2)
    expect(vi.mocked(prisma.invoiceCollaborator.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subContractorId: 'member-user-1', payoutStatus: 'pending' },
        data: { payoutStatus: 'unassigned' },
      })
    )
    expect(vi.mocked(prisma.teamMember.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tm-1' },
        data: expect.objectContaining({ status: 'removed' }),
      })
    )
  })

  it('allows an active admin member of the same team to remove another member', async () => {
    // Caller is not the team owner but an admin member.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-user', privyId: 'privy-owner' } as any)
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({
      id: 'tm-admin',
      ownerId: 'owner-1',
      memberId: 'admin-user',
      role: 'admin',
      status: 'active',
    } as any)

    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(200)
  })

  it('rejects a caller with no owner/admin privilege', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'viewer-user', privyId: 'privy-owner' } as any)
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({
      id: 'tm-viewer',
      ownerId: 'owner-1',
      memberId: 'viewer-user',
      role: 'viewer',
      status: 'active',
    } as any)

    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(403)
  })

  it('rejects removing the last remaining owner', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      ...editorMember,
      id: 'tm-owner',
      role: 'owner',
    } as any)
    vi.mocked(prisma.teamMember.count).mockResolvedValue(1)

    const res = await DELETE(makeRequest(), paramsFor('tm-owner'))
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toBe('Cannot remove the last remaining owner')
    expect(vi.mocked(prisma.teamMember.update)).not.toHaveBeenCalled()
  })

  it('removes an owner when another owner remains', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      ...editorMember,
      id: 'tm-owner',
      role: 'owner',
    } as any)
    vi.mocked(prisma.teamMember.count).mockResolvedValue(2)
    vi.mocked(prisma.teamMember.update).mockResolvedValue({
      id: 'tm-owner',
      role: 'owner',
      status: 'removed',
    } as any)

    const res = await DELETE(makeRequest(), paramsFor('tm-owner'))
    expect(res.status).toBe(200)
  })

  it('does not flag collaborations for a member who never accepted (no memberId)', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      ...editorMember,
      memberId: null,
    } as any)

    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.reassignedCollaborations).toBe(0)
    expect(vi.mocked(prisma.invoiceCollaborator.updateMany)).not.toHaveBeenCalled()
  })

  it('returns 404 when the member does not exist', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), paramsFor('missing'))
    expect(res.status).toBe(404)
  })

  it('returns 404 when the member is already removed', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      ...editorMember,
      status: 'removed',
    } as any)
    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await DELETE(makeRequest(), paramsFor())
    expect(res.status).toBe(404)
  })
})
