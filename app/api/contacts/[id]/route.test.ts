import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockContactFindUnique = vi.fn()
const mockContactUpdate = vi.fn()
const mockContactHardDelete = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    contact: {
      findUnique: (...args: unknown[]) => mockContactFindUnique(...args),
      update: (...args: unknown[]) => mockContactUpdate(...args),
      delete: (...args: unknown[]) => mockContactHardDelete(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { DELETE } from './route'

function makeRequest(url: string, options?: { token?: string }) {
  const headers: Record<string, string> = {}
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'DELETE',
    headers,
  })
}

describe('DELETE /api/contacts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('sets deletedAt instead of performing a hard delete, preserving the row for historical invoice references', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockContactFindUnique.mockResolvedValue({
      id: 'contact-1',
      userId: 'user-1',
      name: 'Grace Hopper',
      email: 'grace@navy.mil',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })

    mockContactUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'contact-1',
      userId: 'user-1',
      name: 'Grace Hopper',
      email: 'grace@navy.mil',
      deletedAt: data.deletedAt,
      createdAt: now,
      updatedAt: data.deletedAt,
    }))

    const req = makeRequest('http://localhost/api/contacts/contact-1', {
      token: 'valid-token',
    })
    const res = await DELETE(req, { params: { id: 'contact-1' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.deleted).toBe(true)
    expect(json.contact.deletedAt).toBeTruthy()
    expect(mockContactUpdate).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { deletedAt: expect.any(Date) },
    })
    expect(mockContactHardDelete).not.toHaveBeenCalled()
  })

  it('rejects deleting a contact that is already soft-deleted (deletedAt !== null), returning 404', async () => {
    mockContactFindUnique.mockResolvedValue({
      id: 'contact-already-deleted',
      userId: 'user-1',
      name: 'Deleted Contact',
      email: 'deleted@example.com',
      deletedAt: new Date('2026-03-15T10:00:00Z'),
    })

    const req = makeRequest(
      'http://localhost/api/contacts/contact-already-deleted',
      {
        token: 'valid-token',
      },
    )
    const res = await DELETE(req, {
      params: { id: 'contact-already-deleted' },
    })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.code).toBe('CONTACT_NOT_FOUND')
    expect(mockContactUpdate).not.toHaveBeenCalled()
  })

  it('permits only the owning user to delete their own contact (403 otherwise)', async () => {
    mockContactFindUnique.mockResolvedValue({
      id: 'contact-foreign',
      userId: 'user-2',
      name: 'Foreign Contact',
      email: 'foreign@example.com',
      deletedAt: null,
    })

    const req = makeRequest('http://localhost/api/contacts/contact-foreign', {
      token: 'valid-token',
    })
    const res = await DELETE(req, { params: { id: 'contact-foreign' } })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.code).toBe('FORBIDDEN_CONTACT_OWNER')
    expect(mockContactUpdate).not.toHaveBeenCalled()
  })
})
