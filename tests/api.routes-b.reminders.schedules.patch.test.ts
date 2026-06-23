import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const reminderScheduleFindFirst = vi.fn()
const reminderScheduleUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    reminderSchedule: {
      findFirst: reminderScheduleFindFirst,
      update: reminderScheduleUpdate,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reminders/schedules/sched_1'

function makeRequest(
  headers: Record<string, string> = { authorization: 'Bearer token' },
  body?: any,
) {
  return new NextRequest(BASE_URL, {
    method: 'PATCH',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('PATCH /api/routes-b/reminders/schedules/[id] (#940)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest({}), { params: Promise.resolve({ id: 'sched_1' }) })

    expect(response.status).toBe(401)
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest(), { params: Promise.resolve({ id: 'sched_1' }) })

    expect(response.status).toBe(404)
  })

  it('returns 404 when the schedule is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindFirst.mockResolvedValue(null)

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest(), { params: Promise.resolve({ id: 'sched_1' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Schedule not found' })
  })

  it('returns 400 when frequency is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindFirst.mockResolvedValue({ id: 'sched_1', userId: 'user_1' })

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest({}, { frequency: 'hourly' }), {
      params: Promise.resolve({ id: 'sched_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'frequency must be one of: daily, weekly, monthly, yearly',
    })
  })

  it('returns 400 when interval is less than 1', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindFirst.mockResolvedValue({ id: 'sched_1', userId: 'user_1' })

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest({}, { interval: 0 }), {
      params: Promise.resolve({ id: 'sched_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'interval must be a positive integer' })
  })

  it('updates the schedule with valid data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindFirst.mockResolvedValue({
      id: 'sched_1',
      userId: 'user_1',
      name: 'Old Name',
      frequency: 'weekly',
    })
    reminderScheduleUpdate.mockResolvedValue({
      id: 'sched_1',
      userId: 'user_1',
      name: 'New Name',
      description: 'Updated description',
      frequency: 'monthly',
      interval: 2,
      timezone: 'America/New_York',
      enabled: false,
      nextRunAt: new Date('2026-07-01T10:00:00Z'),
      lastRunAt: new Date('2026-06-01T10:00:00Z'),
      metadata: { key: 'value' },
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(
      makeRequest(
        {},
        {
          name: 'New Name',
          description: 'Updated description',
          frequency: 'monthly',
          interval: 2,
          timezone: 'America/New_York',
          enabled: false,
          metadata: { key: 'value' },
        },
      ),
      { params: Promise.resolve({ id: 'sched_1' }) },
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.name).toBe('New Name')
    expect(body.frequency).toBe('monthly')
    expect(reminderScheduleUpdate).toHaveBeenCalledWith({
      where: { id: 'sched_1' },
      data: {
        name: 'New Name',
        description: 'Updated description',
        frequency: 'monthly',
        interval: 2,
        timezone: 'America/New_York',
        enabled: false,
        metadata: { key: 'value' },
      },
    })
  })

  it('updates only provided fields', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    reminderScheduleFindFirst.mockResolvedValue({
      id: 'sched_1',
      userId: 'user_1',
      name: 'Old Name',
      frequency: 'weekly',
    })
    reminderScheduleUpdate.mockResolvedValue({
      id: 'sched_1',
      userId: 'user_1',
      name: 'New Name',
      frequency: 'weekly',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { PATCH } = await import('@/app/api/routes-b/reminders/schedules/[id]/route')
    const response = await PATCH(makeRequest({}, { name: 'New Name' }), {
      params: Promise.resolve({ id: 'sched_1' }),
    })

    expect(response.status).toBe(200)
    expect(reminderScheduleUpdate).toHaveBeenCalledWith({
      where: { id: 'sched_1' },
      data: { name: 'New Name' },
    })
  })
})
