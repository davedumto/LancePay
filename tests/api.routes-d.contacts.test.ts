import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const contactFindMany = vi.fn()
const contactFindUnique = vi.fn()
const contactFindFirst = vi.fn()
const contactUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    contact: {
      findMany: contactFindMany,
      findUnique: contactFindUnique,
      findFirst: contactFindFirst,
      update: contactUpdate,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/contacts'

function makeRequest(method: 'GET' | 'DELETE', path: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    headers,
  })
}

describe('Contacts Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/routes-d/contacts', () => {
    it('returns 401 if no authorization header is provided', async () => {
      const { GET } = await import('@/app/api/routes-d/contacts/route')
      const res = await GET(makeRequest('GET', '', null))
      expect(res.status).toBe(401)
    })

    it('returns 200 and lists contacts where deletedAt is null', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      const mockContacts = [{ id: 'c_1', name: 'John Doe', email: 'john@example.com' }]
      contactFindMany.mockResolvedValue(mockContacts)

      const { GET } = await import('@/app/api/routes-d/contacts/route')
      const res = await GET(makeRequest('GET', ''))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.contacts).toEqual(mockContacts)
      expect(contactFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            deletedAt: null,
          },
        })
      )
    })
  })

  describe('GET /api/routes-d/contacts/[id]', () => {
    it('returns 404 if contact does not exist or is soft-deleted', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      contactFindFirst.mockResolvedValue(null)

      const { GET } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await GET(makeRequest('GET', '/c_1'), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(404)
    })

    it('returns 200 and contact details if active', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      const mockContact = { id: 'c_1', name: 'John Doe', userId: 'user-1', deletedAt: null }
      contactFindFirst.mockResolvedValue(mockContact)

      const { GET } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await GET(makeRequest('GET', '/c_1'), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.contact).toEqual(mockContact)
    })
  })

  describe('DELETE /api/routes-d/contacts/[id]', () => {
    it('returns 401 if no authorization header is provided', async () => {
      const { DELETE } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await DELETE(makeRequest('DELETE', '/c_1', null), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(401)
    })

    it('returns 404 if contact does not exist', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      contactFindUnique.mockResolvedValue(null)

      const { DELETE } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await DELETE(makeRequest('DELETE', '/c_1'), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(404)
    })

    it('returns 403 if contact belongs to another user', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      contactFindUnique.mockResolvedValue({ id: 'c_1', userId: 'user-2' })

      const { DELETE } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await DELETE(makeRequest('DELETE', '/c_1'), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(403)
    })

    it('returns 204 and soft deletes contact successfully', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
      userFindUnique.mockResolvedValue({ id: 'user-1' })
      contactFindUnique.mockResolvedValue({ id: 'c_1', userId: 'user-1', deletedAt: null })
      contactUpdate.mockResolvedValue({ id: 'c_1', deletedAt: new Date() })

      const { DELETE } = await import('@/app/api/routes-d/contacts/[id]/route')
      const res = await DELETE(makeRequest('DELETE', '/c_1'), { params: Promise.resolve({ id: 'c_1' }) })
      expect(res.status).toBe(204)
      expect(contactUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c_1' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
          }),
        })
      )
    })
  })
})
