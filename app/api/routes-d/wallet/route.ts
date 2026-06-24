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
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
    })

    if (!wallet) {
      return NextResponse.json({ wallet: null })
    }

    let balances: any[] = []
    try {
      balances = await getAccountBalance(wallet.address)
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Stellar balance in wallet endpoint')
    }

    return NextResponse.json({
      wallet: {
        id: wallet.id,
        stellarAddress: wallet.address,
        network: 'testnet',
        createdAt: wallet.createdAt.toISOString(),
        balances,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET wallet error')
    return NextResponse.json({ error: 'Failed to get wallet' }, { status: 500 })
  }
}
