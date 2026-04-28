import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getAgeingBucket } from '../_lib/ageing'
import { GET as getOverdue } from '../invoices/overdue/route'

describe('ageing bucket helper', () => {
  it('handles bucket boundaries', () => {
    expect(getAgeingBucket(1)).toBe('1_30')
    expect(getAgeingBucket(30)).toBe('1_30')
    expect(getAgeingBucket(31)).toBe('31_60')
    expect(getAgeingBucket(60)).toBe('31_60')
    expect(getAgeingBucket(61)).toBe('61_90')
    expect(getAgeingBucket(90)).toBe('61_90')
    expect(getAgeingBucket(91)).toBe('90_plus')
  })
})

describe('GET /invoices/overdue?bucketed=true', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns empty buckets and totals for each bucket', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1' } as any)
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([] as any)

    const req = new NextRequest('http://localhost/api/routes-b/invoices/overdue?bucketed=true', {
      headers: { authorization: 'Bearer token' },
    })

    const res = await getOverdue(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(json.buckets)).toEqual(['1_30', '31_60', '61_90', '90_plus'])
    expect(json.buckets['1_30']).toEqual([])
    expect(json.buckets['31_60']).toEqual([])
    expect(json.buckets['61_90']).toEqual([])
    expect(json.buckets['90_plus']).toEqual([])
    expect(json.totals['90_plus']).toEqual({ count: 0, amount: 0 })
  })
})
