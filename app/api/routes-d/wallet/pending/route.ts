import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
      select: { id: true, address: true },
    })

    if (!wallet) {
      return NextResponse.json({
        pending: {
          amount: 0,
          currency: 'USD',
          invoiceCount: 0,
        },
      })
    }

    const [pendingInvoices, pendingCount] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'pending',
        },
        _sum: { amount: true },
      }),
      prisma.invoice.count({
        where: {
          userId: user.id,
          status: 'pending',
        },
      }),
    ])

    return NextResponse.json({
      pending: {
        amount: Number(pendingInvoices._sum.amount ?? 0),
        currency: 'USD',
        invoiceCount: pendingCount,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes D wallet pending GET error')
    return NextResponse.json({ error: 'Failed to get pending wallet balances' }, { status: 500 })
  }
}
