import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const searchParams = request.nextUrl.searchParams
    const limitParam = searchParams.get('limit')
    const pageParam = searchParams.get('page')

    const limit = limitParam ? parseInt(limitParam, 10) : 20
    const page = pageParam ? parseInt(pageParam, 10) : 1
    const skip = (page - 1) * limit

    if (isNaN(limit) || limit <= 0 || limit > 100) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 })
    }

    if (isNaN(page) || page <= 0) {
      return NextResponse.json({ error: 'Invalid page parameter' }, { status: 400 })
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { 
          userId: user.id,
          type: 'conversion'
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.transaction.count({
        where: {
          userId: user.id,
          type: 'conversion'
        }
      })
    ])

    const formatted = transactions.map(tx => ({
      id: tx.id,
      status: tx.status,
      amount: Number(tx.amount),
      currency: tx.currency,
      ngnAmount: tx.ngnAmount ? Number(tx.ngnAmount) : null,
      exchangeRate: tx.exchangeRate ? Number(tx.exchangeRate) : null,
      txHash: tx.txHash,
      createdAt: tx.createdAt,
      completedAt: tx.completedAt,
    }))

    return NextResponse.json({
      history: formatted,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'Conversion history GET error')
    return NextResponse.json({ error: 'Failed to get conversion history' }, { status: 500 })
  }
}
