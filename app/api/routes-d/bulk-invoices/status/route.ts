import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getOrCreateUserFromRequest } from '@/app/api/routes-d/bulk-invoices/_shared'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    const user = auth.user

    const jobId = request.nextUrl.searchParams.get('jobId')
    if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

    const job = await prisma.bulkInvoiceJob.findFirst({
      where: { id: jobId, userId: user.id },
      select: {
        id: true,
        status: true,
        totalCount: true,
        successCount: true,
        failedCount: true,
        createdAt: true,
        completedAt: true,
        results: true,
      },
    })

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        totalCount: job.totalCount,
        successCount: job.successCount,
        failedCount: job.failedCount,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt ? job.completedAt.toISOString() : undefined,
      },
      results: (job.results as any) ?? [],
    })
  } catch (error) {
    logger.error({ err: error }, 'Bulk invoices status error:')
    return NextResponse.json({ error: 'Failed to get job status' }, { status: 500 })
  }
}

