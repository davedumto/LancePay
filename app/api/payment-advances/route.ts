import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const DEFAULT_FEE_PERCENTAGE = 2

// Invoice states that cannot back a new advance.
const NON_ADVANCEABLE_INVOICE_STATUSES = ['paid', 'void']
// Advance states that still tie up the invoice (i.e. an "active" advance).
const ACTIVE_ADVANCE_STATUSES = ['pending', 'approved', 'disbursed']

function round(value: number, decimals: number): string {
  return value.toFixed(decimals)
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const searchParams = new URL(request.url).searchParams
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )

    const where = { userId: user.id }

    const [totalRows, advances] = await Promise.all([
      prisma.paymentAdvance.count({ where }),
      prisma.paymentAdvance.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return NextResponse.json({
      advances,
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payment-advances error')
    return NextResponse.json({ error: 'Failed to fetch payment advances' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const invoiceId = body.invoiceId
    if (typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const requestedAmountUSDC = Number(body.requestedAmountUSDC)
    if (!Number.isFinite(requestedAmountUSDC) || requestedAmountUSDC <= 0) {
      return NextResponse.json(
        { error: 'requestedAmountUSDC must be a number greater than 0' },
        { status: 400 },
      )
    }

    let feePercentage = DEFAULT_FEE_PERCENTAGE
    if (body.feePercentage !== undefined && body.feePercentage !== null) {
      feePercentage = Number(body.feePercentage)
      if (!Number.isFinite(feePercentage) || feePercentage < 0) {
        return NextResponse.json(
          { error: 'feePercentage must be a non-negative number' },
          { status: 400 },
        )
      }
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true, status: true },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (NON_ADVANCEABLE_INVOICE_STATUSES.includes(invoice.status)) {
      return NextResponse.json(
        { error: `Cannot request an advance against an invoice in status '${invoice.status}'` },
        { status: 409 },
      )
    }

    const activeAdvance = await prisma.paymentAdvance.findFirst({
      where: { invoiceId, status: { in: ACTIVE_ADVANCE_STATUSES } },
      select: { id: true, status: true },
    })
    if (activeAdvance) {
      return NextResponse.json(
        { error: 'Invoice already has an active advance', advanceId: activeAdvance.id },
        { status: 409 },
      )
    }

    // Fee and repayment are derived from the requested amount so they cannot be
    // spoofed by the client. The advanced principal equals the requested amount;
    // the fee is repaid on top of it.
    const feeAmountUSDC = (requestedAmountUSDC * feePercentage) / 100
    const totalRepaymentUSDC = requestedAmountUSDC + feeAmountUSDC
    const advancedAmountUSDC = requestedAmountUSDC

    // Snapshot the live rate and persist it so the NGN figure stays reproducible
    // even after the rate moves.
    const { rate: exchangeRate } = await getUsdToNgnRate()
    const advancedAmountNGN = advancedAmountUSDC * exchangeRate

    const advance = await prisma.paymentAdvance.create({
      data: {
        userId: user.id,
        invoiceId,
        requestedAmountUSDC: round(requestedAmountUSDC, 2),
        advancedAmountUSDC: round(advancedAmountUSDC, 2),
        advancedAmountNGN: round(advancedAmountNGN, 2),
        exchangeRate: round(exchangeRate, 4),
        feePercentage: round(feePercentage, 2),
        feeAmountUSDC: round(feeAmountUSDC, 2),
        totalRepaymentUSDC: round(totalRepaymentUSDC, 2),
        status: 'pending',
      },
    })

    logger.info({ userId: user.id, invoiceId, advanceId: advance.id }, 'POST /api/payment-advances')

    return NextResponse.json({ paymentAdvance: advance }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payment-advances error')
    return NextResponse.json({ error: 'Failed to create payment advance' }, { status: 500 })
  }
}
