import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const network = searchParams.get('network') ?? 'testnet'

    const addresses = await prisma.depositAddress.findMany({
      where: { userId: user.id, network },
      orderBy: { createdAt: 'desc' },
      select: { id: true, address: true, network: true, label: true, createdAt: true },
    })

    return NextResponse.json({ addresses })
  } catch (error) {
    logger.error({ err: error }, 'GET /deposits/addresses error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: { network?: unknown; label?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { network = 'testnet', label } = body
    if (typeof network !== 'string' || !['mainnet', 'testnet'].includes(network)) {
      return NextResponse.json({ error: 'network must be mainnet or testnet' }, { status: 422 })
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
    if (!wallet) {
      return NextResponse.json({ error: 'Wallet not configured' }, { status: 404 })
    }

    const depositAddress = await prisma.depositAddress.create({
      data: {
        userId: user.id,
        address: wallet.address,
        network,
        label: typeof label === 'string' ? label.trim() : null,
      },
      select: { id: true, address: true, network: true, label: true, createdAt: true },
    })

    logger.info({ userId: user.id, addressId: depositAddress.id }, 'Deposit address generated')

    return NextResponse.json({ address: depositAddress }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /deposits/addresses error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
