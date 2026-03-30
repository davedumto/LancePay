import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
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

    const now = new Date()
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)

    const where = { userId: user.id, type: 'payment', status: 'completed' }

    const [total, thisMonth, lastMonth] = await Promise.all([
      prisma.transaction.aggregate({ where, _sum: { amount: true } }),
      prisma.transaction.aggregate({ 
        where: { ...where, createdAt: { gte: startOfThisMonth } }, 
        _sum: { amount: true } 
      }),
      prisma.transaction.aggregate({ 
        where: { ...where, createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } }, 
        _sum: { amount: true } 
      }),
    ])

    return NextResponse.json({
      earnings: {
        totalEarned: Number(total._sum.amount ?? 0),
        thisMonth: Number(thisMonth._sum.amount ?? 0),
        lastMonth: Number(lastMonth._sum.amount ?? 0),
        currency: 'USDC',
      },
    })
  } catch (error) {
    console.error('Earnings GET error:', error)
    return NextResponse.json({ error: 'Failed to get earnings' }, { status: 500 })
  }
}
