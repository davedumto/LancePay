import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const CANCELLABLE_STATUSES = ['pending', 'queued', 'scheduled']

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim().length === 0) {
      return NextResponse.json({ error: 'Job ID is required' }, { status: 400 })
    }

    const job = await (prisma as any).job.findUnique({ where: { id } })
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: you do not own this job' }, { status: 403 })
    }

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      return NextResponse.json(
        {
          error: `Job cannot be cancelled in status '${job.status}'`,
          cancellableStatuses: CANCELLABLE_STATUSES,
        },
        { status: 409 },
      )
    }

    const cancelled = await (prisma as any).job.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user.id },
      select: { id: true, type: true, status: true, cancelledAt: true },
    })

    logger.info({ userId: user.id, jobId: id, previousStatus: job.status }, 'Job cancelled')

    return NextResponse.json({ job: cancelled })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/jobs/[id]/cancel error')
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 500 })
  }
}
