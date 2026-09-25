import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const page = parsePositiveInteger(searchParams.get('page'), 1)
    const requestedPageSize = parsePositiveInteger(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)
    if (page === null || requestedPageSize === null) {
      return NextResponse.json({ error: 'page and pageSize must be positive integers' }, { status: 400 })
    }

    const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE)
    const where = {
      status: 'pending',
      invoice: { userId: user.id },
    }

    const [total, manualPayments] = await Promise.all([
      prisma.manualPayment.count({ where }),
      prisma.manualPayment.findMany({
        where,
        select: {
          id: true,
          amountPaid: true,
          currency: true,
          paymentMethod: true,
          receiptUrl: true,
          notes: true,
          status: true,
          createdAt: true,
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              clientName: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return NextResponse.json({
      manualPayments: manualPayments.map((payment) => ({
        ...payment,
        amountPaid: payment.amountPaid.toString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/manual-payments/unreconciled error')
    return NextResponse.json({ error: 'Failed to fetch unreconciled manual payments' }, { status: 500 })
  }
}