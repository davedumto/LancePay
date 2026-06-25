import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const trashFindFirst = vi.fn()
const transaction = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    trashItem: { findFirst: trashFindFirst },
    $transaction: transaction,
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-b/trash/item-1/restore'

function req(token: string | null = 'tok') {
  const h = new Headers()
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h })
}

describe('POST /api/routes-b/trash/[id]/restore', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/trash/[id]/restore/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'item-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 when trash item not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    trashFindFirst.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/trash/[id]/restore/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'item-1' }) })
    expect(res.status).toBe(404)
  })

  it('restores item and returns 200', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    trashFindFirst.mockResolvedValue({ id: 'item-1', resourceType: 'invoice', resourceId: 'inv-1', deletedAt: new Date() })
    transaction.mockResolvedValue([])
    const { POST } = await import('@/app/api/routes-b/trash/[id]/restore/route')
    const res = await POST(req(), { params: Promise.resolve({ id: 'item-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.restored).toBe(true)
    expect(json.resourceType).toBe('invoice')
  })
})
