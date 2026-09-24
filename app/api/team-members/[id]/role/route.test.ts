import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PATCH } from './route'
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
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ownerUserId = 'owner-1'
const ownerPrivyId = 'privy-owner'
const memberId = 'tm-1'
const params = { id: memberId }

function makePatch(body: unknown, token = 'valid') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/team-members/${memberId}/role`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Team member role API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: ownerPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: ownerUserId } as never)
    // Target belongs to the caller's own account, so the caller is owner.
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: memberId,
      ownerId: ownerUserId,
      role: 'viewer',
      status: 'active',
    } as never)
    vi.mocked(prisma.teamMember.update).mockImplementation(async ({ data }: { data: unknown }) => ({
      id: memberId,
      ownerId: ownerUserId,
      ...(data as object),
    } as never))
  })

  it('changes a role (happy path)', async () => {
    const res = await PATCH(makePatch({ role: 'editor' }), { params })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.member.role).toBe('editor')
  })

  it('rejects an unknown role', async () => {
    const res = await PATCH(makePatch({ role: 'superuser' }), { params })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid role')
  })

  it('prevents a non-owner from granting owner', async () => {
    // Caller is an admin (not owner) in the team.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-user' } as never)
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({ role: 'admin' } as never)
    const res = await PATCH(makePatch({ role: 'owner' }), { params })
    expect(res.status).toBe(403)
    expect(prisma.teamMember.update).not.toHaveBeenCalled()
  })

  it('rejects demoting the last remaining owner', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: memberId,
      ownerId: ownerUserId,
      role: 'owner',
      status: 'active',
    } as never)
    vi.mocked(prisma.teamMember.count).mockResolvedValue(1 as never)
    const res = await PATCH(makePatch({ role: 'admin' }), { params })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('last remaining owner')
  })

  it('allows demoting an owner when another owner exists', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
      id: memberId,
      ownerId: ownerUserId,
      role: 'owner',
      status: 'active',
    } as never)
    vi.mocked(prisma.teamMember.count).mockResolvedValue(2 as never)
    const res = await PATCH(makePatch({ role: 'admin' }), { params })
    expect(res.status).toBe(200)
  })

  it('returns 404 when the member does not exist', async () => {
    vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ role: 'editor' }), { params })
    expect(res.status).toBe(404)
  })

  it('returns 403 when caller has no role in the team', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'stranger' } as never)
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue(null as never)
    const res = await PATCH(makePatch({ role: 'editor' }), { params })
    expect(res.status).toBe(403)
  })

  it('returns 401 when unauthorized', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await PATCH(makePatch({ role: 'editor' }), { params })
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.teamMember.update).mockRejectedValue(new Error('DB'))
    const res = await PATCH(makePatch({ role: 'editor' }), { params })
    expect(res.status).toBe(500)
  })
})
