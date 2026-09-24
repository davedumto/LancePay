import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    teamMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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

function makeGet(url = 'http://localhost/api/team-members/invite', token = 'valid') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(url, { headers })
}

function makePost(body: unknown, token = 'valid') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/team-members/invite', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Team member invite API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: ownerPrivyId } as never)
    // Default: the caller is the account owner.
    vi.mocked(prisma.user.findUnique).mockImplementation(async (args: unknown) => {
      const a = args as { where: { privyId?: string; id?: string } }
      if (a.where.privyId) return { id: ownerUserId } as never
      return { teamSeatLimit: 5 } as never
    })
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue(null as never)
    vi.mocked(prisma.teamMember.count).mockResolvedValue(1 as never)
  })

  describe('POST', () => {
    it('creates a pending invite (happy path)', async () => {
      vi.mocked(prisma.teamMember.create).mockResolvedValue({
        id: 'tm-new',
        ownerId: ownerUserId,
        email: 'new@example.com',
        role: 'editor',
        status: 'pending',
      } as never)

      const res = await POST(makePost({ email: 'new@example.com', role: 'editor' }))
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.member.status).toBe('pending')
      expect(data.member.email).toBe('new@example.com')
      expect(prisma.teamMember.create).toHaveBeenCalled()
    })

    it('rejects when seat limit is reached', async () => {
      vi.mocked(prisma.teamMember.count).mockResolvedValue(5 as never)
      const res = await POST(makePost({ email: 'new@example.com' }))
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.error).toContain('Seat limit')
      expect(prisma.teamMember.create).not.toHaveBeenCalled()
    })

    it('rejects a duplicate pending invitation', async () => {
      vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({
        id: 'tm-existing',
        status: 'pending',
        email: 'dup@example.com',
      } as never)
      const res = await POST(makePost({ email: 'dup@example.com' }))
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toContain('already pending')
    })

    it('rejects when caller is not owner or admin', async () => {
      // Caller is a viewer in the target team.
      vi.mocked(prisma.user.findUnique).mockImplementation(async (args: unknown) => {
        const a = args as { where: { privyId?: string; id?: string } }
        if (a.where.privyId) return { id: 'viewer-user' } as never
        return { teamSeatLimit: 5 } as never
      })
      vi.mocked(prisma.teamMember.findFirst).mockResolvedValueOnce({ role: 'viewer' } as never)
      const res = await POST(makePost({ email: 'x@example.com', ownerId: ownerUserId }))
      expect(res.status).toBe(403)
    })

    it('rejects an invite that tries to grant owner', async () => {
      const res = await POST(makePost({ email: 'x@example.com', role: 'owner' }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Invalid role')
    })

    it('rejects an invalid email', async () => {
      const res = await POST(makePost({ email: 'not-an-email' }))
      expect(res.status).toBe(400)
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await POST(makePost({ email: 'x@example.com' }))
      expect(res.status).toBe(401)
    })

    it('returns 500 on database error', async () => {
      vi.mocked(prisma.teamMember.create).mockRejectedValue(new Error('DB'))
      const res = await POST(makePost({ email: 'new@example.com' }))
      expect(res.status).toBe(500)
    })
  })

  describe('GET', () => {
    it('returns members with seat usage', async () => {
      vi.mocked(prisma.teamMember.findMany).mockResolvedValue([
        { id: 'a', status: 'active' },
        { id: 'b', status: 'pending' },
        { id: 'c', status: 'removed' },
      ] as never)
      const res = await GET(makeGet())
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.seatLimit).toBe(5)
      expect(data.seatsUsed).toBe(2)
      expect(data.members).toHaveLength(3)
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await GET(makeGet())
      expect(res.status).toBe(401)
    })
  })
})
