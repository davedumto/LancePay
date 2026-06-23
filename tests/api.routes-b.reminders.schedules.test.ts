import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const reminderScheduleFindMany = vi.fn()
const reminderScheduleCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    reminderSchedule: {
      findMany: reminderScheduleFindMany,
      create: reminderScheduleCreate,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reminders/schedules'

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, { headers })
}

describe('GET /api/routes-b/reminders/schedules (#939)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-b/reminders/schedules/route')
    const response = await GET(makeRequest({}))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/reminders/schedules/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/reminders/schedules/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'User not found' })
  })

  it('returns empty schedules array when user has no schedules', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/reminders/schedules/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.schedules).toEqual([])
  })

  it('returns schedules for the authenticated user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindMany.mockResolvedValue([
      {
        id: 'sched_1',
        name: 'Weekly Invoice Reminder',
        description: 'Send reminders for unpaid invoices',
        frequency: 'weekly',
        interval: 1,
        timezone: 'UTC',
        enabled: true,
        nextRunAt: new Date('2026-06-24T10:00:00Z'),
        lastRunAt: new Date('2026-06-17T10:00:00Z'),
        metadata: {},
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/reminders/schedules/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0].name).toBe('Weekly Invoice Reminder')
    expect(reminderScheduleFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
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

describe('POST /api/routes-b/reminders/schedules (#939)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ name: 'Test', frequency: 'daily' }),
    })
    const response = await POST(request)

    expect(response.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ frequency: 'daily' }),
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'name and frequency are required' })
  })

  it('returns 400 when frequency is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Test' }),
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'name and frequency are required' })
  })

  it('returns 400 when frequency is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Test', frequency: 'hourly' }),
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'frequency must be one of: daily, weekly, monthly, yearly',
    })
  })

  it('returns 400 when interval is less than 1', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Test', frequency: 'daily', interval: 0 }),
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'interval must be a positive integer' })
  })

  it('creates a schedule with valid data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleCreate.mockResolvedValue({
      id: 'sched_1',
      userId: 'user_1',
      name: 'Weekly Reminder',
      description: 'Test description',
      frequency: 'weekly',
      interval: 1,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      metadata: {},
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-b/reminders/schedules/route')
    const request = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Weekly Reminder',
        description: 'Test description',
        frequency: 'weekly',
        interval: 2,
        timezone: 'UTC',
      }),
    })
    const response = await POST(request)

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.name).toBe('Weekly Reminder')
    expect(reminderScheduleCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_1',
        name: 'Weekly Reminder',
        description: 'Test description',
        frequency: 'weekly',
        interval: 2,
        timezone: 'UTC',
        enabled: true,
        metadata: {},
      },
    })
  })
})
