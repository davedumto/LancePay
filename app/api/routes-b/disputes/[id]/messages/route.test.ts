import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    dispute: { findUnique: vi.fn() },
    disputeMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const disputeId = 'dsp-1'
const params = { id: disputeId }
const ownerEmail = 'owner@example.com'
const clientEmail = 'client@example.com'

function makeGet(query = '', token = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/routes-b/disputes/${disputeId}/messages${query}`, {
    headers,
  })
}

function makePost(body: unknown, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/routes-b/disputes/${disputeId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function mockDispute(status = 'open') {
  vi.mocked(prisma.dispute.findUnique).mockResolvedValue({
    id: disputeId,
    status,
    invoice: { clientEmail, user: { email: ownerEmail } },
  } as never)
}

function asUser(email: string) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', email } as never)
}

describe('disputes messages API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  })

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const res = await GET(makeGet(), { params })
      expect(res.status).toBe(401)
    })

    it('returns 403 for a user who is not a party', async () => {
      asUser('stranger@example.com')
      mockDispute()
      const res = await GET(makeGet(), { params })
      expect(res.status).toBe(403)
    })

    it('lists messages ordered by createdAt and returns a nextCursor when more remain', async () => {
      asUser(ownerEmail)
      mockDispute()
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, message: `hi ${i}` }))
      vi.mocked(prisma.disputeMessage.findMany).mockResolvedValue(rows as never)

      const res = await GET(makeGet('?limit=2'), { params })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.messages).toHaveLength(2)
      expect(data.nextCursor).toBe('m1')
      expect(prisma.disputeMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { disputeId }, orderBy: { createdAt: 'asc' }, take: 3 }),
      )
    })
  })

  describe('POST', () => {
    it('rejects posting to a resolved dispute with 409', async () => {
      asUser(clientEmail)
      mockDispute('resolved')
      const res = await POST(makePost({ message: 'hello' }), { params })
      expect(res.status).toBe(409)
      expect(prisma.disputeMessage.create).not.toHaveBeenCalled()
    })

    it('returns 403 for a non-party sender', async () => {
      asUser('stranger@example.com')
      mockDispute()
      const res = await POST(makePost({ message: 'hello' }), { params })
      expect(res.status).toBe(403)
    })

    it('rejects an empty message', async () => {
      asUser(clientEmail)
      mockDispute()
      const res = await POST(makePost({ message: '   ' }), { params })
      expect(res.status).toBe(400)
    })

    it('creates a message tagged with the sender party on the happy path', async () => {
      asUser(clientEmail)
      mockDispute()
      vi.mocked(prisma.disputeMessage.create).mockResolvedValue({
        id: 'm-new',
        senderType: 'client',
        message: 'hello',
      } as never)

      const res = await POST(makePost({ message: 'hello' }), { params })
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.message.id).toBe('m-new')
      expect(prisma.disputeMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            disputeId,
            senderType: 'client',
            senderEmail: clientEmail,
            message: 'hello',
          }),
        }),
      )
    })
  })
})
