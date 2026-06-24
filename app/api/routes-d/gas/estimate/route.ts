import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_NETWORKS = ['ethereum', 'polygon', 'bsc', 'arbitrum', 'optimism'] as const

const GAS_FEES: Record<string, { baseFee: number; priorityFee: number }> = {
  ethereum: { baseFee: 0.005, priorityFee: 0.002 },
  polygon:  { baseFee: 0.0001, priorityFee: 0.00005 },
  bsc:      { baseFee: 0.0003, priorityFee: 0.0001 },
  arbitrum: { baseFee: 0.001, priorityFee: 0.0005 },
  optimism: { baseFee: 0.0008, priorityFee: 0.0003 },
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { network, amount, currency = 'USD' } = body

    if (!network) {
      return NextResponse.json({ error: 'network is required' }, { status: 400 })
    }
    if (!ALLOWED_NETWORKS.includes(network)) {
      return NextResponse.json(
        { error: 'network must be one of: ethereum, polygon, bsc, arbitrum, optimism' },
        { status: 400 }
      )
    }
    if (amount === undefined || amount === null || typeof amount !== 'number' || isNaN(amount)) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    if (amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    const { baseFee, priorityFee } = GAS_FEES[network]
    const totalGasFee = baseFee + priorityFee

    return NextResponse.json({
      estimate: {
        network,
        amount,
        currency,
        baseFee,
        priorityFee,
        totalGasFee,
        estimatedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'gas estimate error')
    return NextResponse.json({ error: 'Failed to estimate gas fee' }, { status: 500 })
  }
}
