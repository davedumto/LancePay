/**
 * Tests for issue #3 — invoice scheduling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scheduleInvoice, cancelSchedule, getSchedule, clearSchedules, tickScheduler } from '../_lib/scheduler'

// ── unit tests for scheduler ──────────────────────────────────────────────────

describe('scheduler', () => {
  beforeEach(() => clearSchedules())

  it('schedules an invoice', () => {
    const sendAt = new Date(Date.now() + 60_000)
    const entry = scheduleInvoice('inv-1', 'user-1', sendAt)
    expect(entry.invoiceId).toBe('inv-1')
    expect(entry.sendAt).toEqual(sendAt)
    expect(getSchedule('inv-1')).not.toBeNull()
  })

  it('double-schedule replaces existing', () => {
    const first = new Date(Date.now() + 60_000)
    const second = new Date(Date.now() + 120_000)
    scheduleInvoice('inv-1', 'user-1', first)
    scheduleInvoice('inv-1', 'user-1', second)
    expect(getSchedule('inv-1')!.sendAt).toEqual(second)
  })

  it('cancel removes schedule', () => {
    scheduleInvoice('inv-1', 'user-1', new Date(Date.now() + 60_000))
    const ok = cancelSchedule('inv-1')
    expect(ok).toBe(true)
    expect(getSchedule('inv-1')!.cancelledAt).toBeDefined()
  })

  it('cancel returns false for non-existent schedule', () => {
    expect(cancelSchedule('no-such-invoice')).toBe(false)
  })

  it('tick fires callback for due schedule', async () => {
    const cb = vi.fn().mockResolvedValue(undefined)
    const { registerSendCallback } = await import('../_lib/scheduler')
    registerSendCallback(cb)

    const past = new Date(Date.now() - 1000)
    scheduleInvoice('inv-fire', 'user-1', past)
    await tickScheduler(new Date())
    expect(cb).toHaveBeenCalledWith('inv-fire', 'user-1')
  })

  it('tick does not fire cancelled schedule', async () => {
    const cb = vi.fn().mockResolvedValue(undefined)
    const { registerSendCallback } = await import('../_lib/scheduler')
    registerSendCallback(cb)

    const past = new Date(Date.now() - 1000)
    scheduleInvoice('inv-cancel', 'user-1', past)
    cancelSchedule('inv-cancel')
    await tickScheduler(new Date())
    expect(cb).not.toHaveBeenCalledWith('inv-cancel', expect.anything())
  })
})

// ── route handler tests ───────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-user-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', privyId: 'privy-user-1' }),
    },
    invoice: {
      findFirst: vi.fn(),
    },
  },
}))

import { POST as postSchedule, DELETE as deleteSchedule } from '../invoices/[id]/schedule/route'
import { prisma } from '@/lib/db'

function makeReq(method: string, body?: object) {
  return new Request('http://localhost/api/routes-b/invoices/inv-1/schedule', {
    method,
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }) as any
}

describe('POST /invoices/[id]/schedule', () => {
  beforeEach(() => {
    clearSchedules()
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1', status: 'pending' } as any)
  })

  it('schedules an invoice', async () => {
    const sendAt = new Date(Date.now() + 60_000).toISOString()
    const res = await postSchedule(makeReq('POST', { sendAt }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.status).toBe('scheduled')
    expect(body.sendAt).toBe(sendAt)
  })

  it('rejects sendAt in the past with 400', async () => {
    const sendAt = new Date(Date.now() - 1000).toISOString()
    const res = await postSchedule(makeReq('POST', { sendAt }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects sendAt more than 365 days out with 400', async () => {
    const sendAt = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
    const res = await postSchedule(makeReq('POST', { sendAt }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(400)
  })

  it('cannot schedule a paid invoice', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValueOnce({ id: 'inv-1', status: 'paid' } as any)
    const sendAt = new Date(Date.now() + 60_000).toISOString()
    const res = await postSchedule(makeReq('POST', { sendAt }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(400)
  })

  it('double-schedule replaces existing', async () => {
    const first = new Date(Date.now() + 60_000).toISOString()
    const second = new Date(Date.now() + 120_000).toISOString()
    await postSchedule(makeReq('POST', { sendAt: first }), { params: Promise.resolve({ id: 'inv-1' }) })
    const res = await postSchedule(makeReq('POST', { sendAt: second }), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sendAt).toBe(second)
  })
})

describe('DELETE /invoices/[id]/schedule', () => {
  beforeEach(() => {
    clearSchedules()
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'inv-1', status: 'pending' } as any)
  })

  it('cancels a scheduled invoice', async () => {
    scheduleInvoice('inv-1', 'user-1', new Date(Date.now() + 60_000))
    const res = await deleteSchedule(makeReq('DELETE'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('cancelled')
  })

  it('returns 404 when no schedule exists', async () => {
    const res = await deleteSchedule(makeReq('DELETE'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(404)
  })
})
