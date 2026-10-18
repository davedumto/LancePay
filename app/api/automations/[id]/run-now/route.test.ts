import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockAutomationFindUnique = vi.fn()
const mockAutomationUpdate = vi.fn()
const mockAutomationRunCreate = vi.fn()
const mockAutomationRunUpdate = vi.fn()

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
      update: (...args: unknown[]) => mockAutomationUpdate(...args),
    },
    automationRun: {
      create: (...args: unknown[]) => mockAutomationRunCreate(...args),
      update: (...args: unknown[]) => mockAutomationRunUpdate(...args),
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

import { POST, setAutomationActionExecutor } from './route'

function makeRequest(url: string, options?: { token?: string; body?: unknown }) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('POST /api/automations/[id]/run-now', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setAutomationActionExecutor(null)
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('rejects triggering an automation where isActive is false with 409', async () => {
    mockAutomationFindUnique.mockResolvedValue({
      id: 'auto-inactive',
      userId: 'user-1',
      name: 'Disabled Reminder',
      triggerType: 'invoice_overdue',
      actionType: 'send_email',
      isActive: false,
    })

    const req = makeRequest(
      'http://localhost/api/automations/auto-inactive/run-now',
      {
        token: 'valid-token',
      },
    )

    const res = await POST(req, { params: { id: 'auto-inactive' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('AUTOMATION_INACTIVE')
    expect(mockAutomationRunCreate).not.toHaveBeenCalled()
    expect(mockAutomationUpdate).not.toHaveBeenCalled()
  })

  it('creates AutomationRun with startedAt before execution, sets finishedAt + status after, and updates lastRunAt only after completion', async () => {
    const callOrder: string[] = []

    mockAutomationFindUnique.mockResolvedValue({
      id: 'auto-1',
      userId: 'user-1',
      name: 'Overdue Follow-up',
      triggerType: 'invoice_overdue',
      actionType: 'send_email',
      isActive: true,
    })

    mockAutomationRunCreate.mockImplementation(async ({ data }: any) => {
      callOrder.push('run.create')
      expect(data.startedAt).toBeInstanceOf(Date)
      expect(data.finishedAt).toBeNull()
      return {
        id: 'run-1',
        ...data,
      }
    })

    setAutomationActionExecutor(async () => {
      callOrder.push('executor.run')
      // At execution time, AutomationRun.create has happened, but neither AutomationRun.update nor Automation.update (lastRunAt) has been called!
      expect(mockAutomationRunCreate).toHaveBeenCalledTimes(1)
      expect(mockAutomationRunUpdate).not.toHaveBeenCalled()
      expect(mockAutomationUpdate).not.toHaveBeenCalled()
      return { message: 'Sent reminder email to client' }
    })

    mockAutomationRunUpdate.mockImplementation(async ({ data }: any) => {
      callOrder.push('run.update')
      expect(data.status).toBe('success')
      expect(data.finishedAt).toBeInstanceOf(Date)
      return {
        id: 'run-1',
        automationId: 'auto-1',
        status: data.status,
        message: data.message,
        startedAt: new Date(data.finishedAt.getTime() - 10),
        finishedAt: data.finishedAt,
      }
    })

    mockAutomationUpdate.mockImplementation(async ({ data }: any) => {
      callOrder.push('automation.updateLastRunAt')
      expect(data.lastRunAt).toBeInstanceOf(Date)
      return {
        id: 'auto-1',
        lastRunAt: data.lastRunAt,
      }
    })

    const req = makeRequest(
      'http://localhost/api/automations/auto-1/run-now',
      {
        token: 'valid-token',
      },
    )

    const res = await POST(req, { params: { id: 'auto-1' } })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.run.status).toBe('success')
    expect(json.run.message).toBe('Sent reminder email to client')
    expect(json.run.startedAt).toBeTruthy()
    expect(json.run.finishedAt).toBeTruthy()
    expect(callOrder).toEqual([
      'run.create',
      'executor.run',
      'run.update',
      'automation.updateLastRunAt',
    ])
  })

  it('sets finishedAt and status = failed on AutomationRun even when execution throws', async () => {
    mockAutomationFindUnique.mockResolvedValue({
      id: 'auto-fail',
      userId: 'user-1',
      name: 'Webhook Action',
      triggerType: 'invoice_paid',
      actionType: 'send_notification',
      isActive: true,
    })

    mockAutomationRunCreate.mockImplementation(async ({ data }: any) => ({
      id: 'run-fail',
      ...data,
    }))

    setAutomationActionExecutor(async () => {
      throw new Error('Downstream SMTP timeout')
    })

    mockAutomationRunUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'run-fail',
      automationId: 'auto-fail',
      status: data.status,
      message: data.message,
      startedAt: new Date(data.finishedAt.getTime() - 5),
      finishedAt: data.finishedAt,
    }))

    mockAutomationUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'auto-fail',
      lastRunAt: data.lastRunAt,
    }))

    const req = makeRequest(
      'http://localhost/api/automations/auto-fail/run-now',
      {
        token: 'valid-token',
      },
    )

    const res = await POST(req, { params: { id: 'auto-fail' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.run.status).toBe('failed')
    expect(json.run.message).toContain('Downstream SMTP timeout')
    expect(json.run.finishedAt).toBeTruthy()
    expect(mockAutomationRunUpdate).toHaveBeenCalledWith({
      where: { id: 'run-fail' },
      data: {
        status: 'failed',
        message: 'Downstream SMTP timeout',
        finishedAt: expect.any(Date),
      },
    })
  })
})
