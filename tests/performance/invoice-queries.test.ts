import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { performance } from 'perf_hooks'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const THRESHOLD_MS = 50
const TEST_USER_ID = process.env.TEST_USER_ID ?? 'perf-test-user'
const TEST_CLIENT_EMAIL = process.env.TEST_CLIENT_EMAIL ?? 'perf-client@example.com'

const seededInvoiceIds: string[] = []
const seededTransactionIds: string[] = []
const seededDisputeIds: string[] = []
const seededPaymentAdvanceIds: string[] = []

beforeAll(async () => {
  await prisma.$connect()

  const now = new Date()

  // Seed invoices (150+ records) for various performance scenarios
  for (let i = 0; i < 150; i++) {
    const isPaid = i % 3 === 0
    const isPending = i % 3 === 1

    const invoice = await prisma.invoice.create({
      data: {
        userId: TEST_USER_ID,
        status: isPaid ? 'paid' : isPending ? 'pending' : 'canceled',
        clientEmail: TEST_CLIENT_EMAIL,
        createdAt: new Date(now.getTime() - i * 60_000), // spread over time
        dueDate: new Date(now.getTime() - (i - 30) * 24 * 60_60 * 1000), // some overdue, some future
      },
    })
    // @ts-expect-error id shape depends on schema but is expected to exist
    seededInvoiceIds.push(invoice.id)
  }

  // Additional pending/overdue invoices without clientEmail for overdue/admin scenarios
  for (let i = 0; i < 50; i++) {
    const invoice = await prisma.invoice.create({
      data: {
        userId: TEST_USER_ID,
        status: 'pending',
        createdAt: new Date(now.getTime() - (i + 150) * 60_000),
        dueDate: new Date(now.getTime() - (i + 1) * 24 * 60 * 60 * 1000), // definitely overdue
      },
    })
    // @ts-expect-error id shape depends on schema but is expected to exist
    seededInvoiceIds.push(invoice.id)
  }

  // Seed transactions for the user
  for (let i = 0; i < 100; i++) {
    const transaction = await prisma.transaction.create({
      data: {
        userId: TEST_USER_ID,
        status: i % 2 === 0 ? 'completed' : 'pending',
        createdAt: new Date(now.getTime() - i * 30_000),
      },
    })
    // @ts-expect-error id shape depends on schema but is expected to exist
    seededTransactionIds.push(transaction.id)
  }

  // Seed disputes
  for (let i = 0; i < 50; i++) {
    const dispute = await prisma.dispute.create({
      data: {
        status: i % 2 === 0 ? 'open' : 'closed',
        createdAt: new Date(now.getTime() - i * 45_000),
      },
    })
    // @ts-expect-error id shape depends on schema but is expected to exist
    seededDisputeIds.push(dispute.id)
  }

  // Seed payment advances
  for (let i = 0; i < 20; i++) {
    const paymentAdvance = await prisma.paymentAdvance.create({
      data: {
        userId: TEST_USER_ID,
        status: i % 2 === 0 ? 'pending' : 'approved',
      },
    })
    // @ts-expect-error id shape depends on schema but is expected to exist
    seededPaymentAdvanceIds.push(paymentAdvance.id)
  }
})

afterAll(async () => {
  // Best-effort cleanup of seeded data
  if (seededInvoiceIds.length > 0) {
    await prisma.invoice.deleteMany({
      where: { id: { in: seededInvoiceIds } as any },
    })
  }

  if (seededTransactionIds.length > 0) {
    await prisma.transaction.deleteMany({
      where: { id: { in: seededTransactionIds } as any },
    })
  }

  if (seededDisputeIds.length > 0) {
    await prisma.dispute.deleteMany({
      where: { id: { in: seededDisputeIds } as any },
    })
  }

  if (seededPaymentAdvanceIds.length > 0) {
    await prisma.paymentAdvance.deleteMany({
      where: { id: { in: seededPaymentAdvanceIds } as any },
    })
  }
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
