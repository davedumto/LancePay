import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const {} = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 })
    }

    const batch = await prisma.withdrawalBatch.findFirst({
      where: { id, userId: user.id },
      include: {
        withdrawals: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    const summary = {
      total: batch.withdrawals.length,
      completed: batch.withdrawals.filter((w: any) => w.status === 'completed').length,
      pending: batch.withdrawals.filter((w: any) => w.status === 'pending').length,
      failed: batch.withdrawals.filter((w: any) => w.status === 'failed').length,
    }

    return NextResponse.json({ batch, summary })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/withdrawals/batch/[id] error')
    return NextResponse.json({ error: 'Failed to fetch batch withdrawal' }, { status: 500 })
  }
}
