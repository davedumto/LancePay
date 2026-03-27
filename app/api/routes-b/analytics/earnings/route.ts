import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Calculate date ranges
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const thisWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const thisYear = new Date(now.getFullYear(), 0, 1)

    // Run all queries in parallel
    const [todayEarnings, weekEarnings, monthEarnings, yearEarnings, allTimeEarnings] = await Promise.all([
      // Today
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: today },
        },
        _sum: { amount: true },
      }),
      // This week
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: thisWeek },
        },
        _sum: { amount: true },
      }),
      // This month
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: thisMonth },
        },
        _sum: { amount: true },
      }),
      // This year
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: thisYear },
        },
        _sum: { amount: true },
      }),
      // All time
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
        },
        _sum: { amount: true },
      }),
    ])

    return NextResponse.json({
      today: todayEarnings._sum.amount?.toNumber() || 0,
      thisWeek: weekEarnings._sum.amount?.toNumber() || 0,
      thisMonth: monthEarnings._sum.amount?.toNumber() || 0,
      thisYear: yearEarnings._sum.amount?.toNumber() || 0,
      allTime: allTimeEarnings._sum.amount?.toNumber() || 0,
    })
  } catch (error) {
    logger.error({ err: error }, 'Earnings analytics error')
    return NextResponse.json({ error: 'Failed to get earnings analytics' }, { status: 500 })
  }
}