import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { performance } from 'perf_hooks'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const THRESHOLD_MS = 50
const TEST_USER_ID = process.env.TEST_USER_ID ?? 'perf-test-user'
const TEST_CLIENT_EMAIL = process.env.TEST_CLIENT_EMAIL ?? 'perf-client@example.com'

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
  const start = performance.now()
  const result = await fn()
  return { result, duration: performance.now() - start }
}

describe('Invoice Query Performance', () => {
  it('loads user paid invoices in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.invoice.findMany({
        where: { userId: TEST_USER_ID, status: 'paid' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })

  it('loads user invoices with paidAt filter in <50ms', async () => {
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const { duration } = await measure(() =>
      prisma.invoice.findMany({
        where: { userId: TEST_USER_ID, paidAt: { gte: startDate } },
        orderBy: { paidAt: 'desc' },
        take: 50,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })

  it('loads client invoice history in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.invoice.findMany({
        where: { clientEmail: TEST_CLIENT_EMAIL, status: 'paid' },
        take: 20,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })

  it('loads overdue invoices in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.invoice.findMany({
        where: { status: 'pending', dueDate: { lt: new Date() } },
        take: 100,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })

  it('loads recent invoices for admin dashboard in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.invoice.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })
})

describe('Transaction Query Performance', () => {
  it('loads user transactions by status in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.transaction.findMany({
        where: { userId: TEST_USER_ID, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })
})

describe('Dispute Query Performance', () => {
  it('loads open disputes ordered by recency in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.dispute.findMany({
        where: { status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })
})

describe('AuditEvent Query Performance', () => {
  it('loads audit trail for an invoice in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.auditEvent.findMany({
        where: { invoiceId: 'any-invoice-id' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })
})

describe('PaymentAdvance Query Performance', () => {
  it('loads pending advances for a user in <50ms', async () => {
    const { duration } = await measure(() =>
      prisma.paymentAdvance.findMany({
        where: { userId: TEST_USER_ID, status: 'pending' },
        take: 10,
      }),
    )
    expect(duration).toBeLessThan(THRESHOLD_MS)
  })
})
