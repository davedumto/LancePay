import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PATCH } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    refund: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const userFind = vi.mocked(prisma.user.findUnique)
const refundUpdate = vi.mocked(prisma.refund.updateMany)
const refundFind = vi.mocked(prisma.refund.findUnique)

function call(status: unknown = 'completed') {
  const request = new NextRequest('http://localhost/api/refunds/ref-1/process', {
    method: 'PATCH',
    headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  return PATCH(request, { params: Promise.resolve({ id: 'ref-1' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'admin-privy' } as never)
  userFind.mockResolvedValue({ id: 'admin-1', role: 'admin' } as never)
  refundUpdate.mockResolvedValue({ count: 1 } as never)
  refundFind.mockResolvedValue({ status: 'completed' } as never)
})

describe('PATCH /api/refunds/[id]/process', () => {
  it('transitions a pending refund to completed', async () => {
    const response = await call('completed')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ refund: { id: 'ref-1', status: 'completed' } })
    expect(refundUpdate).toHaveBeenCalledWith({
      where: { id: 'ref-1', status: 'pending' },
      data: { status: 'completed' },
    })
  })

  it('transitions a pending refund to failed when processing does not move funds', async () => {
    const response = await call('failed')
    expect(response.status).toBe(200)
    expect(refundUpdate).toHaveBeenCalledWith({
      where: { id: 'ref-1', status: 'pending' },
      data: { status: 'failed' },
    })
  })

  it('rejects non-admin users', async () => {
    userFind.mockResolvedValue({ id: 'user-1', role: 'user' } as never)
    const response = await call()
    expect(response.status).toBe(403)
    expect(refundUpdate).not.toHaveBeenCalled()
  })

  it('rejects re-processing a terminal refund', async () => {
    refundUpdate.mockResolvedValue({ count: 0 } as never)
    refundFind.mockResolvedValue({ status: 'completed' } as never)
    const response = await call('failed')
    expect(response.status).toBe(409)
  })

  it('rejects statuses other than completed or failed', async () => {
    const response = await call('pending')
    expect(response.status).toBe(400)
    expect(refundUpdate).not.toHaveBeenCalled()
  })
})