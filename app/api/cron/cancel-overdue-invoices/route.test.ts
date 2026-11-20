import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const invoiceFindMany = vi.fn()
const invoiceUpdateMany = vi.fn()
const invoiceCount = vi.fn()
const sendInvoiceCancelledEmail = vi.fn()
const logAuditEvent = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: {
      findMany: (...args: any[]) => invoiceFindMany(...args),
      updateMany: (...args: any[]) => invoiceUpdateMany(...args),
      count: (...args: any[]) => invoiceCount(...args),
    },
  },
}))

vi.mock('@/lib/email', () => ({
  sendInvoiceCancelledEmail: (...args: any[]) => sendInvoiceCancelledEmail(...args),
}))

vi.mock('@/lib/audit', () => ({
  logAuditEvent: (...args: any[]) => logAuditEvent(...args),
}))

function makeRequest(secret: string | null = 'cron_secret') {
  const headers: Record<string, string> = {}
  if (secret !== null) headers.authorization = `Bearer ${secret}`
  return new Request('http://localhost/api/cron/cancel-overdue-invoices', { headers })
}

const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

function makeInvoice(id: string) {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    amount: 100,
    dueDate: oldDate,
    clientEmail: 'client@example.com',
    user: { id: `user_${id}`, name: 'Freelancer', email: 'freelancer@example.com' },
  }
}

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules()
  process.env.CRON_SECRET = 'cron_secret'
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import('./route')
}

describe('GET /api/cron/cancel-overdue-invoices (#1889, #1890)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoiceCount.mockResolvedValue(0)
    invoiceUpdateMany.mockResolvedValue({ count: 1 })
    sendInvoiceCancelledEmail.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    delete process.env.CANCEL_CRON_BATCH_SIZE
    delete process.env.CANCEL_CRON_TIME_BUDGET_MS
    delete process.env.CANCEL_CRON_MAX_PAGES
  })

  it('rejects requests without the CRON_SECRET bearer token', async () => {
    const { GET } = await loadRoute()
    const res = await GET(makeRequest('wrong'))
    expect(res.status).toBe(401)
    expect(invoiceFindMany).not.toHaveBeenCalled()
  })

  it('pages through the backlog with keyset pagination by id', async () => {
    const { GET } = await loadRoute({ CANCEL_CRON_BATCH_SIZE: '2' })
    invoiceFindMany
      .mockResolvedValueOnce([makeInvoice('a'), makeInvoice('b')])
      .mockResolvedValueOnce([makeInvoice('c'), makeInvoice('d')])
      .mockResolvedValueOnce([makeInvoice('e')]) // short page ends the run

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(invoiceFindMany).toHaveBeenCalledTimes(3)
    // Second page resumes after the last id of page one
    expect(invoiceFindMany.mock.calls[1][0]).toMatchObject({
      cursor: { id: 'b' },
      skip: 1,
      take: 2,
      orderBy: { id: 'asc' },
    })
    expect(body.cancelledCount).toBe(5)
    expect(body.processed).toBe(5)
    expect(body.pages).toBe(3)
  })

  it('selects only the user fields needed for the cancellation email', async () => {
    const { GET } = await loadRoute()
    invoiceFindMany.mockResolvedValueOnce([])

    await GET(makeRequest())
    const select = invoiceFindMany.mock.calls[0][0].select
    expect(select.user.select).toEqual({ id: true, name: true, email: true })
  })

  it('skips email and audit when the conditional update loses a race', async () => {
    const { GET } = await loadRoute()
    invoiceFindMany.mockResolvedValueOnce([makeInvoice('paid-mid-flight')])
    // Simulates the MoonPay webhook settling the invoice between read and write
    invoiceUpdateMany.mockResolvedValueOnce({ count: 0 })
    invoiceCount.mockResolvedValueOnce(0)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(invoiceUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'paid-mid-flight',
        status: 'pending',
      }),
      data: expect.objectContaining({ status: 'cancelled' }),
    })
    expect(sendInvoiceCancelledEmail).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(body.cancelledCount).toBe(0)
    expect(body.processed).toBe(1)
  })

  it('sends email and audit only for successfully cancelled invoices', async () => {
    const { GET } = await loadRoute()
    invoiceFindMany.mockResolvedValueOnce([makeInvoice('ok')])
    invoiceCount.mockResolvedValueOnce(0)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(logAuditEvent).toHaveBeenCalledWith(
      'ok',
      'invoice.auto_cancelled',
      null,
      expect.objectContaining({ reason: expect.any(String) }),
    )
    expect(sendInvoiceCancelledEmail).toHaveBeenCalledTimes(1)
    expect(body.cancelledCount).toBe(1)
    expect(body.cancelledInvoiceIds).toEqual(['ok'])
  })

  it('stops when the time budget is reached and reports the remaining backlog', async () => {
    const { GET } = await loadRoute({
      CANCEL_CRON_BATCH_SIZE: '5',
      CANCEL_CRON_TIME_BUDGET_MS: '1000',
    })
    invoiceFindMany.mockResolvedValue([makeInvoice('x1'), makeInvoice('x2')])
    invoiceCount.mockResolvedValue(7)

    // Date.now jumps past the budget after the first invoice check
    let tick = 0
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + (tick++ * 600))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.outOfBudget).toBe(true)
    expect(body.processed).toBeLessThan(2)
    expect(body.remaining).toBe(7)
    vi.restoreAllMocks()
  })
})
