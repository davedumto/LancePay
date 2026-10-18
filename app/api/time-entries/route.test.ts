import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    timeEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET, POST } from './route'

function makePostRequest(body: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/time-entries', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/time-entries${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('POST /api/time-entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'freelancer@lancepay.io',
    })
    mockPrisma.timeEntry.findMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest(
        { description: 'Frontend work', hours: 2, rateUsdc: 75, occurredOn: '2026-03-01T09:00:00Z' },
        null,
      ),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when description is missing or hours exceed 24', async () => {
    const resNoDesc = await POST(
      makePostRequest({ description: '', hours: 2, rateUsdc: 75, occurredOn: '2026-03-01T09:00:00Z' }),
    )
    expect(resNoDesc.status).toBe(400)

    const resTooManyHours = await POST(
      makePostRequest({ description: 'Work', hours: 26, rateUsdc: 75, occurredOn: '2026-03-01T09:00:00Z' }),
    )
    expect(resTooManyHours.status).toBe(400)
  })

  it('returns 404 when specified projectId does not belong to user', async () => {
    mockPrisma.project.findFirst.mockResolvedValueOnce(null)

    const res = await POST(
      makePostRequest({
        description: 'API integration',
        hours: 3,
        rateUsdc: 100,
        occurredOn: '2026-03-01T09:00:00Z',
        projectId: 'proj-missing',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when startTime/endTime overlaps with an existing time entry', async () => {
    mockPrisma.timeEntry.findMany.mockResolvedValueOnce([
      {
        id: 'te-existing',
        hours: 2,
        occurredOn: new Date('2026-03-01T10:00:00Z'), // 10:00 - 12:00
      },
    ])

    const res = await POST(
      makePostRequest({
        description: 'Overlapping session',
        startTime: '2026-03-01T11:00:00Z',
        endTime: '2026-03-01T13:00:00Z',
        rateUsdc: 80,
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.conflictingEntryId).toBe('te-existing')
  })

  it('returns 409 when daily hours exceed 24 hours', async () => {
    mockPrisma.timeEntry.findMany.mockResolvedValueOnce([
      {
        id: 'te-1',
        hours: 20,
        occurredOn: new Date('2026-03-01T01:00:00Z'),
      },
    ])

    const res = await POST(
      makePostRequest({
        description: 'Late shift',
        hours: 6,
        rateUsdc: 80,
        occurredOn: '2026-03-01T21:00:00Z',
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('exceed 24 hours')
  })

  it('creates a time entry with duration rounding and returns 201', async () => {
    mockPrisma.timeEntry.create.mockResolvedValueOnce({
      id: 'te-new',
      userId: 'user-1',
      projectId: null,
      invoiceId: null,
      description: 'Smart contract audit',
      hours: 1.5,
      rateUsdc: 120,
      occurredOn: new Date('2026-03-01T14:00:00Z'),
      status: 'draft',
    })

    const res = await POST(
      makePostRequest({
        description: 'Smart contract audit',
        startTime: '2026-03-01T14:00:00Z',
        endTime: '2026-03-01T15:28:00Z', // 88 mins -> rounds to 90 mins (1.5h) with roundToMinutes=15
        roundToMinutes: 15,
        rateUsdc: 120,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe('te-new')
    expect(body.data.hours).toBe(1.5)
    expect(body.billableAmount).toBe(180)
  })
})

describe('GET /api/time-entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'freelancer@lancepay.io',
    })
  })

  it('returns paginated time entries with summary totals', async () => {
    mockPrisma.timeEntry.findMany.mockResolvedValueOnce([
      {
        id: 'te-1',
        userId: 'user-1',
        description: 'Backend API',
        hours: 4,
        rateUsdc: 100,
        occurredOn: new Date('2026-03-01T09:00:00Z'),
        status: 'draft',
        project: { id: 'p-1', name: 'LancePay Core' },
      },
    ])
    mockPrisma.timeEntry.count.mockResolvedValueOnce(1)

    const res = await GET(makeGetRequest('status=draft'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.summary.totalHours).toBe(4)
    expect(body.summary.totalAmount).toBe(400)
  })
})
