import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_NETWORKS = ['stellar', 'bank']
const STALE_AFTER_MS = 10 * 60 * 1000

type Snapshot = {
  network: string
  status: string
  latencyMs: number | null
  message: string | null
  capturedAt: Date
}

function effectiveStatus(snapshot: Snapshot | undefined): {
  status: 'operational' | 'degraded' | 'down' | 'unknown'
  message: string | null
  latencyMs: number | null
  updatedAt: Date | null
} {
  if (!snapshot) {
    return { status: 'unknown', message: 'No health data recorded', latencyMs: null, updatedAt: null }
  }
  const age = Date.now() - new Date(snapshot.capturedAt).getTime()
  if (age > STALE_AFTER_MS) {
    return {
      status: 'unknown',
      message: 'Health data is stale',
      latencyMs: snapshot.latencyMs,
      updatedAt: snapshot.capturedAt,
    }
  }
  const status = ['operational', 'degraded', 'down'].includes(snapshot.status)
    ? (snapshot.status as 'operational' | 'degraded' | 'down')
    : 'unknown'
  return {
    status,
    message: snapshot.message,
    latencyMs: snapshot.latencyMs,
    updatedAt: snapshot.capturedAt,
  }
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const networkFilter = searchParams.get('network')?.toLowerCase()
    if (networkFilter && !VALID_NETWORKS.includes(networkFilter)) {
      return NextResponse.json(
        { error: `Invalid network. Supported: ${VALID_NETWORKS.join(', ')}` },
        { status: 400 },
      )
    }

    const networks = networkFilter ? [networkFilter] : VALID_NETWORKS

    // Latest snapshot per network; the health poller writes these
    const snapshots: Snapshot[] = await (prisma as any).networkStatusSnapshot.findMany({
      where: { network: { in: networks } },
      orderBy: { capturedAt: 'desc' },
    })

    const latestByNetwork = new Map<string, Snapshot>()
    for (const snap of snapshots) {
      if (!latestByNetwork.has(snap.network)) latestByNetwork.set(snap.network, snap)
    }

    const statuses = networks.map((network) => ({
      network,
      ...effectiveStatus(latestByNetwork.get(network)),
    }))

    const overall = statuses.some((s) => s.status === 'down')
      ? 'down'
      : statuses.some((s) => s.status === 'degraded')
        ? 'degraded'
        : statuses.every((s) => s.status === 'operational')
          ? 'operational'
          : 'unknown'

    return NextResponse.json({ overall, networks: statuses })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/networks/status error')
    return NextResponse.json({ error: 'Failed to fetch network status' }, { status: 500 })
  }
}
