import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    teamMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ownerUserId = 'owner-1'
const ownerPrivyId = 'privy-owner'
const targetId = 'tm-target'
const params = { id: targetId }

function makePost(token = 'valid') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/team-members/${targetId}/transfer-ownership`, {
    method: 'POST',
    headers,
  })
}

describe('Team member transfer-ownership API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: ownerPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: ownerUserId } as never)
    // Target is an active admin in the caller's own account.
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: targetId,
      ownerId: ownerUserId,
      role: 'admin',
      status: 'active',
    } as never)
    // Current owner row.
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({
      id: 'tm-owner',
      ownerId: ownerUserId,
      role: 'owner',
    } as never)
    vi.mocked(prisma.$transaction).mockResolvedValue([
      { id: 'tm-owner', role: 'admin' },
      { id: targetId, role: 'owner' },
    ] as never)
  })

  it('transfers ownership atomically (happy path)', async () => {
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.member.role).toBe('owner')
    expect(prisma.$transaction).toHaveBeenCalledOnce()
    // The swap is issued as a single transaction of two updates.
    const ops = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown[]
    expect(ops).toHaveLength(2)
  })

  it('rejects when caller is not the current owner', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'not-owner' } as never)
    // Caller is only an admin.
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValueOnce({ role: 'admin' } as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(403)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects transferring to a pending member', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: targetId,
      ownerId: ownerUserId,
      role: 'viewer',
      status: 'pending',
    } as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('active team member')
  })

  it('rejects when target is already the owner', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: targetId,
      ownerId: ownerUserId,
      role: 'owner',
      status: 'active',
    } as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the target does not exist', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(null as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 400 when there is no current owner to transfer from', async () => {
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue(null as never)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('No current owner')
  })

  it('returns 401 when unauthorized', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB'))
    const res = await POST(makePost(), { params })
    expect(res.status).toBe(500)
  })
})
