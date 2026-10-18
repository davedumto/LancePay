import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockAutomationFindUnique = vi.fn()
const mockAutomationRunFindMany = vi.fn()
const mockAutomationRunCount = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    automation: {
      findUnique: (...args: unknown[]) => mockAutomationFindUnique(...args),
    },
    automationRun: {
      findMany: (...args: unknown[]) => mockAutomationRunFindMany(...args),
      count: (...args: unknown[]) => mockAutomationRunCount(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET } from './route'

function makeRequest(url: string, options?: { token?: string }) {
  const headers: Record<string, string> = {}
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/automations/[id]/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('restricts visibility strictly to the automation owner with 403', async () => {
    mockAutomationFindUnique.mockResolvedValue({
      id: 'auto-foreign',
      userId: 'user-2',
      name: 'Other User Rule',
    })

    const req = makeRequest(
      'http://localhost/api/automations/auto-foreign/runs',
      {
        token: 'valid-token',
      },
    )

    const res = await GET(req, { params: { id: 'auto-foreign' } })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.code).toBe('FORBIDDEN_AUTOMATION_OWNER')
    expect(mockAutomationRunFindMany).not.toHaveBeenCalled()
  })

  it('supports pagination and filtering by status, and includes message + computed durationMs from startedAt to finishedAt', async () => {
    mockAutomationFindUnique.mockResolvedValue({
      id: 'auto-1',
      userId: 'user-1',
      name: 'Invoice Paid Notification',
    })

    const start1 = new Date('2026-04-02T10:00:00.000Z')
    const end1 = new Date('2026-04-02T10:00:01.350Z') // 1350ms
    const start2 = new Date('2026-04-01T10:00:00.000Z')

    mockAutomationRunFindMany.mockResolvedValue([
      {
        id: 'run-completed',
        automationId: 'auto-1',
        status: 'success',
        message: 'Dispatched Slack notification',
        startedAt: start1,
        finishedAt: end1,
      },
      {
        id: 'run-in-progress',
        automationId: 'auto-1',
        status: 'success',
        message: null,
        startedAt: start2,
        finishedAt: null,
      },
    ])
    mockAutomationRunCount.mockResolvedValue(4)

    const req = makeRequest(
      'http://localhost/api/automations/auto-1/runs?page=2&limit=2&status=success',
      {
        token: 'valid-token',
      },
    )

    const res = await GET(req, { params: { id: 'auto-1' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.runs).toHaveLength(2)
    expect(json.runs[0].id).toBe('run-completed')
    expect(json.runs[0].message).toBe('Dispatched Slack notification')
    expect(json.runs[0].durationMs).toBe(1350)
    expect(json.runs[0].duration).toBe(1350)
    expect(json.runs[1].id).toBe('run-in-progress')
    expect(json.runs[1].durationMs).toBeNull()

    expect(json.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 4,
      totalPages: 2,
    })

    expect(mockAutomationRunFindMany).toHaveBeenCalledWith({
      where: {
        automationId: 'auto-1',
        status: 'success',
      },
      orderBy: { startedAt: 'desc' },
      skip: 2,
      take: 2,
    })
  })
})
