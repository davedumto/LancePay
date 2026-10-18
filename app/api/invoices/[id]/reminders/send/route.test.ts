import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockReminderFindFirst = vi.fn()
const mockReminderCreate = vi.fn()
const mockSendInvoiceToClient = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
    },
    paymentReminder: {
      findFirst: (...args: unknown[]) => mockReminderFindFirst(...args),
      create: (...args: unknown[]) => mockReminderCreate(...args),
    },
  },
}))

vi.mock('@/lib/email', () => ({
  sendInvoiceToClient: (...args: unknown[]) => mockSendInvoiceToClient(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { POST, deriveReminderTypeAndOffset } from './route'

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

describe('POST /api/invoices/[id]/reminders/send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      name: 'Alex Freelancer',
      email: 'alex@example.com',
      role: 'user',
    })
    mockReminderFindFirst.mockResolvedValue(null)
    mockSendInvoiceToClient.mockResolvedValue({ success: true })
  })

  it('rejects sending a reminder for an invoice that is already paid or void with 409', async () => {
    mockInvoiceFindUnique.mockResolvedValueOnce({
      id: 'inv-paid',
      userId: 'user-1',
      status: 'paid',
    })

    const reqPaid = makeRequest(
      'http://localhost/api/invoices/inv-paid/reminders/send',
      { token: 'valid-token' },
    )
    const resPaid = await POST(reqPaid, { params: { id: 'inv-paid' } })
    expect(resPaid.status).toBe(409)
    const jsonPaid = await resPaid.json()
    expect(jsonPaid.code).toBe('INVOICE_NOT_REMINDABLE')

    mockInvoiceFindUnique.mockResolvedValueOnce({
      id: 'inv-void',
      userId: 'user-1',
      status: 'void',
    })

    const reqVoid = makeRequest(
      'http://localhost/api/invoices/inv-void/reminders/send',
      { token: 'valid-token' },
    )
    const resVoid = await POST(reqVoid, { params: { id: 'inv-void' } })
    expect(resVoid.status).toBe(409)

    expect(mockReminderCreate).not.toHaveBeenCalled()
  })

  it('avoids sending a duplicate reminder within the cooldown window of the last one (429)', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      status: 'pending',
      clientEmail: 'client@example.com',
      dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    })

    // Sent 5 minutes ago (< 1 hour cooldown)
    mockReminderFindFirst.mockResolvedValue({
      id: 'rem-recent',
      invoiceId: 'inv-1',
      reminderType: 'before_due',
      daysOffset: 3,
      sentAt: new Date(Date.now() - 5 * 60 * 1000),
    })

    const req = makeRequest(
      'http://localhost/api/invoices/inv-1/reminders/send',
      { token: 'valid-token' },
    )
    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    const json = await res.json()
    expect(json.code).toBe('REMINDER_COOLDOWN_ACTIVE')
    expect(mockReminderCreate).not.toHaveBeenCalled()
  })

  it('records reminderType and daysOffset consistently with scheduled reminder jobs', async () => {
    const refNow = new Date('2026-04-10T12:00:00Z')
    expect(
      deriveReminderTypeAndOffset(new Date('2026-04-13T12:00:00Z'), refNow),
    ).toEqual({
      reminderType: 'before_due',
      daysOffset: 3,
    })
    expect(
      deriveReminderTypeAndOffset(new Date('2026-04-10T20:00:00Z'), refNow),
    ).toEqual({
      reminderType: 'on_due',
      daysOffset: 0,
    })
    expect(
      deriveReminderTypeAndOffset(new Date('2026-04-03T12:00:00Z'), refNow),
    ).toEqual({
      reminderType: 'after_due',
      daysOffset: 7,
    })

    const overdueDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-overdue',
      userId: 'user-1',
      invoiceNumber: 'INV-100',
      clientEmail: 'client@example.com',
      amount: 250,
      currency: 'USD',
      status: 'overdue',
      dueDate: overdueDate,
      paymentLink: 'https://pay.lancepay.io/inv-overdue',
    })

    mockReminderCreate.mockImplementation(async ({ data }: any) => ({
      id: 'rem-new',
      ...data,
    }))

    const req = makeRequest(
      'http://localhost/api/invoices/inv-overdue/reminders/send',
      { token: 'valid-token' },
    )
    const res = await POST(req, { params: { id: 'inv-overdue' } })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.reminder.id).toBe('rem-new')
    expect(json.reminder.reminderType).toBe('after_due')
    expect(json.reminder.daysOffset).toBe(3)
  })
})
