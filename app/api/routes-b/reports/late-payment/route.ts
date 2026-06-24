import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/reports/late-payment — late payment report ──
//
// Returns two sets of data for the authenticated user:
//   1. currently_overdue  — open invoices whose dueDate is in the past
//   2. paid_late          — paid invoices where paidAt > dueDate
//
// Optional query params:
//   year      — filter to a specific calendar year (2000–2100)
//   currency  — informational; defaults to "USDC"

const MIN_YEAR = 2000
const MAX_YEAR = 2100

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function parseYear(raw: string | null): number | null | undefined {
  // undefined  → param present but invalid
  // null       → param absent (no filter)
  // number     → valid year
  if (raw === null) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < MIN_YEAR || n > MAX_YEAR) return undefined
  return n
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const yearRaw = searchParams.get('year')
    const year = parseYear(yearRaw)

    if (year === undefined) {
      return NextResponse.json(
        { error: `Invalid year. Must be an integer between ${MIN_YEAR} and ${MAX_YEAR}.` },
        { status: 400 },
      )
    }

    const now = new Date()

    // ── Date range helpers ──────────────────────────────────────────────────
    const yearStart = year !== null ? new Date(`${year}-01-01T00:00:00Z`) : null
    const yearEnd = year !== null ? new Date(`${year + 1}-01-01T00:00:00Z`) : null

    const dueDateFilter = yearStart && yearEnd ? { gte: yearStart, lt: yearEnd } : undefined
    const paidAtFilter = yearStart && yearEnd ? { gte: yearStart, lt: yearEnd } : undefined

    // ── 1. Currently overdue invoices ───────────────────────────────────────
    const overdueInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: { in: ['pending', 'overdue'] },
        dueDate: {
          not: null,
          lt: now,
          ...(dueDateFilter ?? {}),
        },
      },
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        dueDate: true,
        status: true,
        createdAt: true,
      },
      orderBy: { dueDate: 'asc' },
    })

    // ── 2. Invoices paid late (paidAt > dueDate) ────────────────────────────
    const paidLateInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'paid',
        dueDate: { not: null },
        paidAt: {
          not: null,
          ...(paidAtFilter ?? {}),
        },
      },
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { paidAt: 'desc' },
    })

    // Filter paid-late in application code — Prisma doesn't support
    // cross-column comparisons without raw SQL.
    const actuallyLate = paidLateInvoices.filter(
      (inv) => inv.paidAt && inv.dueDate && new Date(inv.paidAt as Date) > new Date(inv.dueDate as Date),
    )

    // ── Build response items ────────────────────────────────────────────────
    const overdueItems = overdueInvoices.map((inv) => {
      const dueDate = inv.dueDate ? new Date(inv.dueDate as Date) : null
      const daysOverdue = dueDate
        ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientName: (inv.clientName as string | null) ?? null,
        clientEmail: inv.clientEmail as string,
        amount: Number(inv.amount),
        currency: (inv.currency as string) || 'USDC',
        dueDate: dueDate?.toISOString() ?? null,
        daysOverdue: Math.max(0, daysOverdue),
        status: inv.status as string,
      }
    })

    const paidLateItems = actuallyLate.map((inv) => {
      const dueDate = inv.dueDate ? new Date(inv.dueDate as Date) : null
      const paidAt = inv.paidAt ? new Date(inv.paidAt as Date) : null
      const daysLate =
        dueDate && paidAt
          ? Math.floor((paidAt.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
          : 0
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientName: (inv.clientName as string | null) ?? null,
        clientEmail: inv.clientEmail as string,
        amount: Number(inv.amount),
        currency: (inv.currency as string) || 'USDC',
        dueDate: dueDate?.toISOString() ?? null,
        paidAt: paidAt?.toISOString() ?? null,
        daysLate: Math.max(0, daysLate),
      }
    })

    // ── Summary metrics ─────────────────────────────────────────────────────
    const totalOverdueAmount = overdueItems.reduce((s, inv) => s + inv.amount, 0)
    const totalPaidLateAmount = paidLateItems.reduce((s, inv) => s + inv.amount, 0)

    return NextResponse.json({
      currency: 'USDC',
      ...(year !== null ? { year } : {}),
      summary: {
        overdueCount: overdueItems.length,
        totalOverdueAmount: Math.round(totalOverdueAmount * 100) / 100,
        paidLateCount: paidLateItems.length,
        totalPaidLateAmount: Math.round(totalPaidLateAmount * 100) / 100,
      },
      currentlyOverdue: overdueItems,
      paidLate: paidLateItems,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/reports/late-payment error')
    return NextResponse.json({ error: 'Failed to generate late payment report' }, { status: 500 })
  }
}
