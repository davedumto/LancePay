import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/routes-d/chargebacks/[id] — fetch a specific chargeback

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const db = prisma as unknown as {
  chargeback: {
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
      return NextResponse.json({ error: 'Chargeback ID is required' }, { status: 400 })
    }

    const chargeback = await db.chargeback.findFirst({
      where: { id, userId: user.id },
    })

    if (!chargeback) {
      return NextResponse.json({ error: 'Chargeback not found' }, { status: 404 })
    }

    logger.info({ userId: user.id, chargebackId: id }, 'GET /api/routes-d/chargebacks/[id]')
    return NextResponse.json({ chargeback })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/chargebacks/[id] error')
    return NextResponse.json({ error: 'Failed to fetch chargeback' }, { status: 500 })
  }
}
