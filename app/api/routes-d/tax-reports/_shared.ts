import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getOrCreateUserFromRequest } from '@/app/api/routes-d/bulk-invoices/_shared'
import { PLATFORM_FEE_RATE, WITHDRAWAL_FEE_RATE } from '@/lib/fee-rates'

export { PLATFORM_FEE_RATE, WITHDRAWAL_FEE_RATE }

export function getYearBounds(year: number) {
  const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0))
  const end = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0))
  return { start, end }
}

export function parseYearParam(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get('year')
  if (!raw) return null
  const y = Number(raw)
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return null
  return y
}

export function monthKeyUTC(d: Date) {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

export function computePlatformFee(amount: number) {
  return round2(amount * PLATFORM_FEE_RATE)
}

export function computeWithdrawalFee(amount: number) {
  return round2(amount * WITHDRAWAL_FEE_RATE)
}

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export async function getTaxAuth(request: NextRequest) {
  const auth = await getOrCreateUserFromRequest(request)
  if ('error' in auth) return auth
  const user = auth.user
  const userFull = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, email: true, name: true } })
  return { user: userFull ?? user }
}

export async function fetchTaxTransactions(params: { userId: string; year: number }) {
  const { userId, year } = params
  const { start, end } = getYearBounds(year)

  // Income is represented by "incoming" (pay route) and "payment" (MoonPay webhook)
  const income = await prisma.transaction.findMany({
    where: {
      userId,
      status: 'completed',
      type: { in: ['incoming', 'payment'] },
      completedAt: { not: null, gte: start, lt: end },
    },
    orderBy: { completedAt: 'asc' },
    include: {
      invoice: { select: { invoiceNumber: true, clientEmail: true, clientName: true, description: true, paidAt: true } },
    },
  })

  const refunds = await prisma.transaction.findMany({
    where: {
      userId,
      status: 'completed',
      type: 'refund',
      completedAt: { not: null, gte: start, lt: end },
    },
    orderBy: { completedAt: 'asc' },
  })

  const withdrawals = await prisma.transaction.findMany({
    where: {
      userId,
      status: 'completed',
      type: 'withdrawal',
      completedAt: { not: null, gte: start, lt: end },
    },
    orderBy: { completedAt: 'asc' },
  })

  return { income, refunds, withdrawals, start, end }
}

