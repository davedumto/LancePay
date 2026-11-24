import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    tag: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function req(method: 'GET' | 'POST', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/tags', { method, headers, body })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/tags', () => {
  it('returns 401 without a token', async () => {
    const res = await GET(req('GET', undefined, {}))
    expect(res.status).toBe(401)
  })

  it('returns tags sorted by name', async () => {
    vi.mocked(prisma.tag.findMany).mockResolvedValue([{ id: 'a', name: 'alpha' }] as never)
    const res = await GET(req('GET'))
    expect(res.status).toBe(200)
    expect(prisma.tag.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, name: true, color: true, createdAt: true },
      orderBy: { name: 'asc' },
    })
  })
})

describe('POST /api/tags', () => {
  it('creates a tag', async () => {
    vi.mocked(prisma.tag.create).mockResolvedValue({ id: 't1', name: 'rush', color: '#112233' } as never)
    const res = await POST(req('POST', JSON.stringify({ name: 'rush', color: '#112233' })))
    expect(res.status).toBe(201)
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', name: 'rush', color: '#112233' },
      select: { id: true, name: true, color: true, createdAt: true },
    })
  })

  it('rejects a color that is not a 7-character hex code', async () => {
    const res = await POST(req('POST', JSON.stringify({ name: 'rush', color: 'blue' })))
    expect(res.status).toBe(400)
    expect(prisma.tag.create).not.toHaveBeenCalled()
  })

  it('returns 409 when the name already exists for the user', async () => {
    vi.mocked(prisma.tag.create).mockRejectedValue({ code: 'P2002' })
    const res = await POST(req('POST', JSON.stringify({ name: 'rush', color: '#112233' })))
    expect(res.status).toBe(409)
  })
})
