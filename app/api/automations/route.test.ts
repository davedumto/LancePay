import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockAutomationFindMany = vi.fn()
const mockAutomationCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    automation: {
      findMany: (...args: unknown[]) => mockAutomationFindMany(...args),
      create: (...args: unknown[]) => mockAutomationCreate(...args),
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

import { GET, POST } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Automations API (/api/automations)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
  })

  it('rejects unknown triggerType, unknown actionType, or unsupported combinations with 400', async () => {
    const reqBadTrigger = makeRequest('http://localhost/api/automations', {
      token: 'valid-token',
      body: {
        name: 'Bad Trigger',
        triggerType: 'moon_eclipse',
        actionType: 'send_email',
        config: { subject: 'Hello' },
      },
    })
    const resBadTrigger = await POST(reqBadTrigger)
    expect(resBadTrigger.status).toBe(400)
    const jsonBadTrigger = await resBadTrigger.json()
    expect(jsonBadTrigger.code).toBe('INVALID_TRIGGER_TYPE')

    const reqBadAction = makeRequest('http://localhost/api/automations', {
      token: 'valid-token',
      body: {
        name: 'Bad Action',
        triggerType: 'invoice_paid',
        actionType: 'launch_rocket',
        config: {},
      },
    })
    const resBadAction = await POST(reqBadAction)
    expect(resBadAction.status).toBe(400)
    const jsonBadAction = await resBadAction.json()
    expect(jsonBadAction.code).toBe('INVALID_ACTION_TYPE')

    // Unsupported combination: client_added cannot tag an invoice
    const reqBadCombo = makeRequest('http://localhost/api/automations', {
      token: 'valid-token',
      body: {
        name: 'Unsupported Combo',
        triggerType: 'client_added',
        actionType: 'tag_invoice',
        config: { tagId: 'tag-1' },
      },
    })
    const resBadCombo = await POST(reqBadCombo)
    expect(resBadCombo.status).toBe(400)
    const jsonBadCombo = await resBadCombo.json()
    expect(jsonBadCombo.code).toBe('UNSUPPORTED_TRIGGER_ACTION_COMBINATION')

    expect(mockAutomationCreate).not.toHaveBeenCalled()
  })

  it('validates the config JSON payload shape matches what the chosen trigger and action require', async () => {
    // Missing subject/template for send_email
    const reqMissingEmailSubject = makeRequest(
      'http://localhost/api/automations',
      {
        token: 'valid-token',
        body: {
          name: 'Email without subject',
          triggerType: 'invoice_paid',
          actionType: 'send_email',
          config: {},
        },
      },
    )
    const resMissingEmail = await POST(reqMissingEmailSubject)
    expect(resMissingEmail.status).toBe(400)
    const jsonMissingEmail = await resMissingEmail.json()
    expect(jsonMissingEmail.code).toBe('INVALID_AUTOMATION_CONFIG')

    // Negative daysOverdue for invoice_overdue
    const reqBadOverdueDays = makeRequest('http://localhost/api/automations', {
      token: 'valid-token',
      body: {
        name: 'Negative Overdue Days',
        triggerType: 'invoice_overdue',
        actionType: 'send_email',
        config: { daysOverdue: -3, subject: 'Overdue Notice' },
      },
    })
    const resBadOverdue = await POST(reqBadOverdueDays)
    expect(resBadOverdue.status).toBe(400)
    const jsonBadOverdue = await resBadOverdue.json()
    expect(jsonBadOverdue.code).toBe('INVALID_AUTOMATION_CONFIG')

    expect(mockAutomationCreate).not.toHaveBeenCalled()
  })

  it('creates an automation rule with validated trigger, action, and config, defaulting isActive to true', async () => {
    const now = new Date('2026-04-01T10:00:00Z')
    mockAutomationCreate.mockImplementation(async ({ data }: any) => ({
      id: 'auto-1',
      ...data,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    }))

    const req = makeRequest('http://localhost/api/automations', {
      token: 'valid-token',
      body: {
        name: 'Overdue 7-Day Email Reminder',
        triggerType: 'invoice_overdue',
        actionType: 'send_email',
        config: {
          daysOverdue: 7,
          subject: 'Friendly reminder: Invoice is 7 days overdue',
          template: 'overdue-reminder-v1',
        },
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.automation.id).toBe('auto-1')
    expect(json.automation.isActive).toBe(true)
    expect(json.automation.triggerType).toBe('invoice_overdue')
    expect(json.automation.actionType).toBe('send_email')
    expect(json.automation.config.daysOverdue).toBe(7)
  })

  it('lists automations for the authenticated user via GET', async () => {
    mockAutomationFindMany.mockResolvedValue([
      {
        id: 'auto-1',
        userId: 'user-1',
        name: 'Paid Notification',
        triggerType: 'invoice_paid',
        actionType: 'send_notification',
        config: { message: 'Invoice paid!' },
        isActive: true,
        lastRunAt: null,
        createdAt: new Date('2026-04-01T10:00:00Z'),
        updatedAt: new Date('2026-04-01T10:00:00Z'),
      },
    ])

    const req = makeRequest('http://localhost/api/automations', {
      method: 'GET',
      token: 'valid-token',
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.automations[0].id).toBe('auto-1')
  })
})
