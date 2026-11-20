import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const KNOWN_STATUSES = ['earned', 'paid', 'clawed_back']

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const searchParams = new URL(request.url).searchParams
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )

    // Restricted to rows where the caller is the referrer.
    const where = { referrerId: user.id }

    const [totalRows, grouped] = await Promise.all([
      prisma.referralEarning.count({ where }),
      prisma.referralEarning.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
        _sum: { amountUsdc: true, platformFee: true },
      }),
    ])

    const earnings = await prisma.referralEarning.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    })

    const totals: Record<string, { count: number; amountUsdc: number | string | null; platformFee: number | string | null }> = {}
    for (const status of KNOWN_STATUSES) {
      totals[status] = { count: 0, amountUsdc: null, platformFee: null }
    }
    for (const row of grouped) {
      totals[row.status] = {
        count: row._count.status,
        amountUsdc: row._sum.amountUsdc ? row._sum.amountUsdc.toString() : null,
        platformFee: row._sum.platformFee ? row._sum.platformFee.toString() : null,
      }
    }

    return NextResponse.json({
      earnings,
      totals,
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/referral-earnings error')
    return NextResponse.json({ error: 'Failed to fetch referral earnings' }, { status: 500 })
  }
}