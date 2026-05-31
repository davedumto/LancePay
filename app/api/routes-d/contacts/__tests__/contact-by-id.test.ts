import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, PATCH, DELETE } from '../[id]/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const contactDelegate = prisma.contact as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  findFirst: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

const user = { id: 'user-1' }
const otherUserContact = {
  id: 'c-1',
  userId: 'user-2',
  name: 'Wrong Owner',
  email: 'wrong@example.com',
  company: null,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}
const ownedContact = {
  id: 'c-1',
  userId: 'user-1',
  name: 'Owner',
  email: 'owner@example.com',
  company: 'ACME',
  notes: 'VIP',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

function makeRequest(
  method: 'GET' | 'PATCH' | 'DELETE',
  authHeader = 'Bearer token',
  body?: unknown,
): NextRequest {
  const init: RequestInit = {
    method,
    headers: authHeader ? { authorization: authHeader } : {},
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return new NextRequest('http://localhost/api/routes-d/contacts/c-1', init)
}

const params = { params: Promise.resolve({ id: 'c-1' }) }

describe('routes-d contacts/[id] handlers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('GET', () => {
    it('returns 401 when the token is missing', async () => {
      mockedVerify.mockResolvedValue(null as never)
      const res = await GET(makeRequest('GET', ''), params)
      expect(res.status).toBe(401)
    })

    it('returns 404 for missing contacts', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(null)
      const res = await GET(makeRequest('GET'), params)
      expect(res.status).toBe(404)
    })

    it('returns 403 when the contact belongs to a different user', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(otherUserContact)
      const res = await GET(makeRequest('GET'), params)
      expect(res.status).toBe(403)
    })

    it('returns the contact for the owner with nullable fields normalised', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue({
        ...ownedContact,
        company: null,
        notes: null,
      })
      const res = await GET(makeRequest('GET'), params)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.contact).toMatchObject({
        id: 'c-1',
        email: 'owner@example.com',
        company: null,
        notes: null,
      })
    })
  })

  describe('PATCH', () => {
    it('validates email format and rejects with 400', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(ownedContact)
      const res = await PATCH(
        makeRequest('PATCH', 'Bearer token', { email: 'not-an-email' }),
        params,
      )
      expect(res.status).toBe(400)
      expect(contactDelegate.update).not.toHaveBeenCalled()
    })

    it('returns 409 when another contact already uses the new email', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(ownedContact)
      contactDelegate.findFirst.mockResolvedValue({ id: 'c-2' })

      const res = await PATCH(
        makeRequest('PATCH', 'Bearer token', { email: 'taken@example.com' }),
        params,
      )
      expect(res.status).toBe(409)
      expect(contactDelegate.update).not.toHaveBeenCalled()
    })

    it('updates only supplied fields and echoes the new contact', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(ownedContact)
      contactDelegate.update.mockResolvedValue({
        ...ownedContact,
        name: 'Owner Renamed',
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      })

      const res = await PATCH(
        makeRequest('PATCH', 'Bearer token', { name: 'Owner Renamed' }),
        params,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.contact.name).toBe('Owner Renamed')
      expect(contactDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c-1' },
          data: { name: 'Owner Renamed' },
        }),
      )
    })

    it('is a no-op echo when no recognised fields are supplied', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(ownedContact)
      const res = await PATCH(
        makeRequest('PATCH', 'Bearer token', { ignored: true }),
        params,
      )
      expect(res.status).toBe(200)
      expect(contactDelegate.update).not.toHaveBeenCalled()
    })
  })

  describe('DELETE', () => {
    it('returns 404 when the contact does not exist', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(null)
      const res = await DELETE(makeRequest('DELETE'), params)
      expect(res.status).toBe(404)
      expect(contactDelegate.delete).not.toHaveBeenCalled()
    })

    it('returns 403 when the contact belongs to a different user', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(otherUserContact)
      const res = await DELETE(makeRequest('DELETE'), params)
      expect(res.status).toBe(403)
    })

    it('returns 204 and calls delete on the happy path', async () => {
      mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
      mockedUserFindUnique.mockResolvedValue(user as never)
      contactDelegate.findUnique.mockResolvedValue(ownedContact)
      contactDelegate.delete.mockResolvedValue({})
      const res = await DELETE(makeRequest('DELETE'), params)
      expect(res.status).toBe(204)
      expect(contactDelegate.delete).toHaveBeenCalledWith({
        where: { id: 'c-1' },
      })
    })
  })
})
