import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_NETWORKS = ['stellar']
const MAX_DAYS = 90

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)

    const network = (searchParams.get('network') ?? 'stellar').toLowerCase()
    if (!VALID_NETWORKS.includes(network)) {
      return NextResponse.json(
        { error: `Invalid network. Supported: ${VALID_NETWORKS.join(', ')}` },
        { status: 400 },
      )
    }

    const daysRaw = parseInt(searchParams.get('days') ?? '7', 10)
    if (!Number.isFinite(daysRaw) || daysRaw < 1 || daysRaw > MAX_DAYS) {
      return NextResponse.json(
        { error: `days must be between 1 and ${MAX_DAYS}` },
        { status: 400 },
      )
    }

    const since = new Date(Date.now() - daysRaw * 24 * 60 * 60 * 1000)

    const snapshots = await (prisma as any).onchainFeeSnapshot.findMany({
      where: { network, capturedAt: { gte: since } },
      orderBy: { capturedAt: 'asc' },
      select: {
        id: true,
        network: true,
        avgFeeStroops: true,
        minFeeStroops: true,
        maxFeeStroops: true,
        ledgerCloseTimeMs: true,
        capturedAt: true,
      },
    })

    const avgOverWindow =
      snapshots.length > 0
        ? Math.round(
            snapshots.reduce((sum: number, s: any) => sum + s.avgFeeStroops, 0) / snapshots.length,
          )
        : null

    const peak =
      snapshots.length > 0 ? Math.max(...snapshots.map((s: any) => s.maxFeeStroops)) : null

    return NextResponse.json({
      network,
      days: daysRaw,
      summary: {
        sampleCount: snapshots.length,
        avgFeeStroops: avgOverWindow,
        peakFeeStroops: peak,
      },
      history: snapshots,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/onchain/fee-history error')
    return NextResponse.json({ error: 'Failed to fetch fee history' }, { status: 500 })
  }
}
