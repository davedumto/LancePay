import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contact: { updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { DELETE } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function deleteRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/contacts/contact-1', { method: 'DELETE', headers })
}

const ctx = (id = 'contact-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.contact.updateMany).mockResolvedValue({ count: 1 } as never)
})

describe('DELETE /api/contacts/[id]', () => {
  it('soft-deletes by setting deletedAt instead of removing the row', async () => {
    const before = Date.now()
    const res = await DELETE(deleteRequest(), ctx())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    const args = vi.mocked(prisma.contact.updateMany).mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: { deletedAt: Date }
    }
    expect(args.data.deletedAt).toBeInstanceOf(Date)
    expect(args.data.deletedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(Object.keys(args.data)).toEqual(['deletedAt'])
  })

  it('only matches the caller\'s own, not-yet-deleted contact', async () => {
    await DELETE(deleteRequest(), ctx('contact-42'))

    expect(prisma.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'contact-42', userId: 'user-1', deletedAt: null } }),
    )
  })

  it('returns 404 for a contact that is already soft-deleted', async () => {
    vi.mocked(prisma.contact.updateMany).mockResolvedValueOnce({ count: 0 } as never)

    const res = await DELETE(deleteRequest(), ctx())

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Contact not found' })
  })

  it('returns 404 (not 403) for another user\'s contact, so existence is not revealed', async () => {
    // The ownership filter matches nothing for someone else's contact.
    vi.mocked(prisma.contact.updateMany).mockResolvedValueOnce({ count: 0 } as never)

    const res = await DELETE(deleteRequest(), ctx('someone-elses'))

    expect(res.status).toBe(404)
    expect(prisma.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    )
  })

  it('returns 404 for an unknown id', async () => {
    vi.mocked(prisma.contact.updateMany).mockResolvedValueOnce({ count: 0 } as never)
    expect((await DELETE(deleteRequest(), ctx('nope'))).status).toBe(404)
  })

  it('returns 401 without a token and does not write', async () => {
    const res = await DELETE(deleteRequest({}), ctx())
    expect(res.status).toBe(401)
    expect(prisma.contact.updateMany).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid or the user does not exist', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null as never)
    expect((await DELETE(deleteRequest(), ctx())).status).toBe(401)

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null as never)
    expect((await DELETE(deleteRequest(), ctx())).status).toBe(401)
    expect(prisma.contact.updateMany).not.toHaveBeenCalled()
  })

  it('returns 500 when the database write fails', async () => {
    vi.mocked(prisma.contact.updateMany).mockRejectedValueOnce(new Error('db down'))

    const res = await DELETE(deleteRequest(), ctx())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to delete contact' })
  })
})
