import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/routes-d/wallet/snapshots/[id] — download a specific wallet snapshot

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const db = prisma as unknown as {
  walletSnapshot: {
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  }
}

export async function GET(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const {} = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Snapshot ID is required' }, { status: 400 })
    }

    const snapshot = await db.walletSnapshot.findFirst({
      where: { id, userId: user.id },
    })

    if (!snapshot) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
    }

    logger.info({ userId: user.id, snapshotId: id }, 'GET /api/routes-d/wallet/snapshots/[id]')
    return NextResponse.json({ snapshot })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/wallet/snapshots/[id] error')
    return NextResponse.json({ error: 'Failed to fetch snapshot' }, { status: 500 })
  }
}
