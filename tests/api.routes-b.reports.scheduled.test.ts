import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const scheduledReportFindMany = vi.fn()
const scheduledReportCreate = vi.fn()
const scheduledReportFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    scheduledReport: {
      findMany: scheduledReportFindMany,
      create: scheduledReportCreate,
      findUnique: scheduledReportFindUnique,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reports/scheduled'

function makeGetRequest(
  headers: Record<string, string> = { authorization: 'Bearer token' },
  searchParams?: Record<string, string>,
) {
  const url = new URL(BASE_URL)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value)
    }
  }
  return new NextRequest(url.toString(), { headers })
}

function makePostRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = { authorization: 'Bearer token' },
) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/reports/scheduled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest({}))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest())

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'User not found' })
  })

  it('returns 400 when reportType query param is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest({}, { reportType: 'invalid' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'reportType must be one of: aging, cash-flow, hours-billed, tax-summary, yoy',
    })
    expect(scheduledReportFindMany).not.toHaveBeenCalled()
  })

  it('returns empty scheduledReports array when user has none', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    scheduledReportFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.scheduledReports).toEqual([])
  })

  it('returns scheduled reports for the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    scheduledReportFindMany.mockResolvedValue([
      {
        id: 'sr_1',
        name: 'Monthly Tax Summary',
        description: 'Tax report for accountant',
        reportType: 'tax-summary',
        frequency: 'monthly',
        interval: 1,
        timezone: 'UTC',
        enabled: true,
        nextRunAt: new Date('2026-07-01T09:00:00Z'),
        lastRunAt: null,
        metadata: { year: 2026 },
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.scheduledReports).toHaveLength(1)
    expect(body.scheduledReports[0].name).toBe('Monthly Tax Summary')
    expect(scheduledReportFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        reportType: true,
        frequency: true,
        interval: true,
        timezone: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  })

  it('filters by reportType when query param is provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    scheduledReportFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await GET(makeGetRequest({}, { reportType: 'aging' }))

    expect(response.status).toBe(200)
    expect(scheduledReportFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', reportType: 'aging' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        reportType: true,
        frequency: true,
        interval: true,
        timezone: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  })
})

describe('POST /api/routes-b/reports/scheduled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({ name: 'Test', reportType: 'aging', frequency: 'weekly' }, {}),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(makePostRequest({ reportType: 'aging', frequency: 'weekly' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, reportType, and frequency are required',
    })
  })

  it('returns 400 when reportType is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(makePostRequest({ name: 'Test', frequency: 'weekly' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, reportType, and frequency are required',
    })
  })

  it('returns 400 when frequency is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(makePostRequest({ name: 'Test', reportType: 'aging' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, reportType, and frequency are required',
    })
  })

  it('returns 400 when reportType is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({ name: 'Test', reportType: 'profit-loss', frequency: 'weekly' }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'reportType must be one of: aging, cash-flow, hours-billed, tax-summary, yoy',
    })
  })

  it('returns 400 when frequency is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({ name: 'Test', reportType: 'aging', frequency: 'hourly' }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'frequency must be one of: daily, weekly, monthly, yearly',
    })
  })

  it('returns 400 when interval is less than 1', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({ name: 'Test', reportType: 'aging', frequency: 'daily', interval: 0 }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'interval must be a positive integer' })
  })

  it('returns 400 when metadata is not an object', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({
        name: 'Test',
        reportType: 'tax-summary',
        frequency: 'monthly',
        metadata: 'invalid',
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'metadata must be a valid JSON object' })
  })

  it('returns 409 when a scheduled report with the same name already exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    scheduledReportFindUnique.mockResolvedValue({ id: 'sr_1', userId: 'user_1', name: 'Test' })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({ name: 'Test', reportType: 'aging', frequency: 'weekly' }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'A scheduled report with this name already exists',
    })
    expect(scheduledReportCreate).not.toHaveBeenCalled()
  })

  it('creates a scheduled report with valid data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    scheduledReportFindUnique.mockResolvedValue(null)
    scheduledReportCreate.mockResolvedValue({
      id: 'sr_1',
      userId: 'user_1',
      name: 'Weekly Aging Report',
      description: 'Outstanding invoices',
      reportType: 'aging',
      frequency: 'weekly',
      interval: 1,
      timezone: 'America/New_York',
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      metadata: {},
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-b/reports/scheduled/route')
    const response = await POST(
      makePostRequest({
        name: 'Weekly Aging Report',
        description: 'Outstanding invoices',
        reportType: 'aging',
        frequency: 'weekly',
        interval: 1,
        timezone: 'America/New_York',
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.name).toBe('Weekly Aging Report')
    expect(scheduledReportFindUnique).toHaveBeenCalledWith({
      where: {
        userId_name: {
          userId: 'user_1',
          name: 'Weekly Aging Report',
        },
      },
    })
    expect(scheduledReportCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_1',
        name: 'Weekly Aging Report',
        description: 'Outstanding invoices',
        reportType: 'aging',
        frequency: 'weekly',
        interval: 1,
        timezone: 'America/New_York',
        enabled: true,
        metadata: {},
      },
    })
  })
})
