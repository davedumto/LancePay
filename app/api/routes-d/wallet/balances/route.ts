import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getAccountBalance } from '@/lib/stellar'
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

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    if (!user.wallet) {
      return NextResponse.json({ balances: [] })
    }

    try {
      const balances = await getAccountBalance(user.wallet.address)
      return NextResponse.json({ balances })
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Stellar balances')
      return NextResponse.json({ balances: [] })
    }
  } catch (error) {
    logger.error({ err: error }, 'GET wallet balances error')
    return NextResponse.json({ error: 'Failed to get wallet balances' }, { status: 500 })
  }
}
