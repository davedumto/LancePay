import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: any,
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
      return NextResponse.json({ error: 'Job ID is required' }, { status: 400 })
    }

    const job = await prisma.bulkInvoiceJob.findFirst({
      where: { id, userId: user.id },
    })

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const progress = job.totalCount > 0
      ? Math.round(((job.successCount + job.failedCount) / job.totalCount) * 100)
      : 0

    return NextResponse.json({
      job: {
        ...job,
        progress,
        isComplete: job.status === 'completed' || job.status === 'failed',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/jobs/[id] error')
    return NextResponse.json({ error: 'Failed to fetch job' }, { status: 500 })
  }
}
