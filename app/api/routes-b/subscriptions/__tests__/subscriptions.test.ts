import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscription: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('../../_lib/openapi', () => ({ registerRoute: vi.fn() }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedCount = vi.mocked(prisma.subscription.count)
const mockedFindMany = vi.mocked(prisma.subscription.findMany)
const mockedCreate = vi.mocked(prisma.subscription.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }

const fakeSub = {
  id: 'sub-1',
  clientName: 'Alice',
  clientEmail: 'alice@example.com',
  description: 'Monthly retainer',
  amount: { toString: () => '500' },
  currency: 'USD',
  frequency: 'monthly',
  interval: 1,
  status: 'active',
  nextGenerationDate: new Date('2026-09-01'),
  lastGeneratedAt: null,
  createdAt: new Date('2026-08-01'),
}

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe('GET /api/routes-b/subscriptions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(fakeUser as never)
    mockedCount.mockResolvedValue(1)
    mockedFindMany.mockResolvedValue([fakeSub] as never)
  })

  it('returns paginated subscriptions', async () => {
    const req = makeRequest('GET', 'http://localhost/api/routes-b/subscriptions')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.subscriptions).toHaveLength(1)
    expect(body.subscriptions[0].id).toBe('sub-1')
    expect(body.pagination.total).toBe(1)
    expect(body.pagination.page).toBe(1)
  })

  it('filters by status when provided', async () => {
    mockedCount.mockResolvedValue(0)
    mockedFindMany.mockResolvedValue([])
    const req = makeRequest('GET', 'http://localhost/api/routes-b/subscriptions?status=paused')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockedCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'paused' }) }),
    )
    expect(body.subscriptions).toHaveLength(0)
  })

  it('rejects invalid status with 400', async () => {
    const req = makeRequest('GET', 'http://localhost/api/routes-b/subscriptions?status=invalid')
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 without auth token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const req = makeRequest('GET', 'http://localhost/api/routes-b/subscriptions')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('clamps limit to 50', async () => {
    const req = makeRequest('GET', 'http://localhost/api/routes-b/subscriptions?limit=999')
    await GET(req)
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    )
  })
})

describe('POST /api/routes-b/subscriptions', () => {
  const createdAt = new Date('2026-08-25')
  const nextDate = new Date('2026-09-25')

  const createdSub = {
    id: 'sub-new',
    clientEmail: 'bob@example.com',
    clientName: 'Bob',
    description: 'Weekly report',
    amount: { toString: () => '200' },
    currency: 'USD',
    frequency: 'monthly',
    interval: 1,
    status: 'active',
    nextGenerationDate: nextDate,
    createdAt,
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(fakeUser as never)
    mockedCreate.mockResolvedValue(createdSub as never)
  })

  it('creates subscription and returns 201', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      clientName: 'Bob',
      description: 'Weekly report',
      amount: 200,
      currency: 'USD',
      frequency: 'monthly',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toBe('sub-new')
    expect(body.status).toBe('active')
    expect(typeof body.nextGenerationDate).toBe('string')
  })

  it('defaults currency to USD and frequency to monthly', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      amount: 100,
    })
    await POST(req)
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: 'USD', frequency: 'monthly', interval: 1 }),
      }),
    )
  })

  it('returns 400 when clientEmail is missing', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      description: 'Retainer',
      amount: 100,
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when amount is not positive', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      amount: -50,
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid frequency value', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      amount: 100,
      frequency: 'biannual',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid email address', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'not-an-email',
      description: 'Retainer',
      amount: 100,
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid startDate', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      amount: 100,
      startDate: 'not-a-date',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('stores email lowercased and currency uppercased', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'BOB@Example.COM',
      description: 'Retainer',
      amount: 100,
      currency: 'eur',
    })
    await POST(req)
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientEmail: 'bob@example.com',
          currency: 'EUR',
        }),
      }),
    )
  })

  it('rejects a malformed payload via createSubscriptionSchema with validation details', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      // malformed billing values: amount must be a positive number (not a string),
      // interval must be a positive integer (not a fractional value)
      amount: 'not-a-number',
      interval: 1.5,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid request body')
    expect(body.details).toBeDefined()
    expect(body.details.amount).toBeDefined()
    expect(body.details.interval).toBeDefined()
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it('rejects an amount exceeding the schema maximum', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-b/subscriptions', {
      clientEmail: 'bob@example.com',
      description: 'Retainer',
      amount: 100001,
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid request body')
    expect(body.details.amount).toBeDefined()
    expect(mockedCreate).not.toHaveBeenCalled()
  })
})
