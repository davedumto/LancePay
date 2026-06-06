import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn() }) },
  default: { child: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn() }) },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findMany)

function makeRequest(params: Record<string, string> = {}, auth = 'Bearer token'): NextRequest {
  const url = new URL('http://localhost/api/routes-d/analytics/top-months')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1', timezone: null } as never)
  mockedInvoiceFind.mockResolvedValue([])
})

describe('GET /api/routes-d/analytics/top-months', () => {
  it('returns 401 when no auth header is provided', async () => {
    const req = new NextRequest('http://localhost/api/routes-d/analytics/top-months', {
      method: 'GET',
    })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(404)
  })

  it('returns 200 with empty topMonths when no paid invoices exist', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.topMonths).toEqual([])
    expect(json.tz).toBe('UTC')
  })

  it('returns 400 for an invalid timezone', async () => {
    const res = await GET(makeRequest({ tz: 'Not/AZone' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.fields).toHaveProperty('tz')
  })

  it('correctly ranks months by earnings and returns top 3 by default', async () => {
    mockedInvoiceFind.mockResolvedValue([
      { amount: 100, paidAt: new Date('2024-01-15T10:00:00Z') },
      { amount: 500, paidAt: new Date('2024-03-10T10:00:00Z') },
      { amount: 300, paidAt: new Date('2024-02-20T10:00:00Z') },
      { amount: 200, paidAt: new Date('2024-03-25T10:00:00Z') },
      { amount: 50,  paidAt: new Date('2024-04-01T10:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ tz: 'UTC' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    // March = 700, Feb = 300, Jan = 100 → top 3
    expect(json.topMonths[0].month).toBe('2024-03')
    expect(json.topMonths[0].earned).toBe(700)
    expect(json.topMonths[1].month).toBe('2024-02')
    expect(json.topMonths[2].month).toBe('2024-01')
    expect(json.topMonths.length).toBe(3)
  })

  it('respects the limit query parameter', async () => {
    mockedInvoiceFind.mockResolvedValue([
      { amount: 100, paidAt: new Date('2024-01-15T10:00:00Z') },
      { amount: 200, paidAt: new Date('2024-02-15T10:00:00Z') },
      { amount: 300, paidAt: new Date('2024-03-15T10:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ limit: '1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.topMonths.length).toBe(1)
  })

  it('uses user.timezone when no ?tz= param is provided', async () => {
    mockedUserFind.mockResolvedValue({ id: 'user-1', timezone: 'Africa/Lagos' } as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tz).toBe('Africa/Lagos')
  })

  it('skips invoices with null paidAt', async () => {
    mockedInvoiceFind.mockResolvedValue([
      { amount: 100, paidAt: null },
      { amount: 200, paidAt: new Date('2024-01-15T10:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ tz: 'UTC' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.topMonths.length).toBe(1)
    expect(json.topMonths[0].earned).toBe(200)
  })

  it('returns 500 on unexpected database error', async () => {
    mockedInvoiceFind.mockRejectedValue(new Error('DB failure') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
