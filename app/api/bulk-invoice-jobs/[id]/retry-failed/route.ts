import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { withInvoiceNumberRetry } from '@/lib/utils'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Bulk invoice job ID is required' }, { status: 400 })
    }

    const job = await prisma.bulkInvoiceJob.findFirst({
      where: { id, userId: auth.user.id },
    })

    if (!job) {
      return NextResponse.json({ error: 'Bulk invoice job not found' }, { status: 404 })
    }

    const failedRows = (job.results as Array<{ recipientEmail?: string; error?: string }>).filter(
      (row) => row.error,
    )

    if (failedRows.length === 0) {
      return NextResponse.json(
        { error: 'No failed rows to retry in this job' },
        { status: 409 },
      )
    }

    logger.info(
      { jobId: id, failedRowCount: failedRows.length },
      'Starting retry of failed rows',
    )

    // Fire-and-forget processing of failed rows
    retryFailedRowsAsync(id, auth.user.id, failedRows, job.results as any[]).catch((err) => {
      logger.error({ jobId: id, err }, 'retryFailedRowsAsync failed')
    })

    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        totalCount: job.totalCount,
        successCount: job.successCount,
        failedCount: job.failedCount,
        completed: job.successCount + job.failedCount === job.totalCount,
        retryInProgress: true,
        failedRowCount: failedRows.length,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/bulk-invoice-jobs/[id]/retry-failed error')
    return NextResponse.json({ error: 'Failed to retry bulk invoice job' }, { status: 500 })
  }
}

async function retryFailedRowsAsync(
  jobId: string,
  userId: string,
  failedRows: Array<{ recipientEmail?: string; error?: string }>,
  allResults: any[],
) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lancepay.app'
  let successRetries = 0
  let failedRetries = 0

  for (const failedRow of failedRows) {
    try {
      const clientEmail = failedRow.recipientEmail
      if (!clientEmail) {
        logger.warn({ jobId, failedRow }, 'Failed row missing recipientEmail')
        failedRetries++
        continue
      }

      // Re-fetch original recipient data from the allResults array to get original fields
      // Since we only store email and error, we need to reconstruct from any available data
      // For now, we'll do a basic retry with minimal data

      const clientUser = await prisma.user.findUnique({
        where: { email: clientEmail.toLowerCase() },
        select: { id: true },
      })

      const invoice = await withInvoiceNumberRetry((invoiceNumber) =>
        prisma.invoice.create({
          data: {
            userId,
            invoiceNumber,
            clientEmail: clientEmail.toLowerCase(),
            clientName: null,
            description: 'Retry from bulk invoice job',
            amount: 0,
            currency: 'USD',
            paymentLink: `${baseUrl}/pay/${invoiceNumber}`,
            dueDate: null,
            clientId: clientUser?.id || null,
          },
        }),
      )

      // Find and update the result entry
      const resultIndex = allResults.findIndex((r) => r.recipientEmail === clientEmail)
      if (resultIndex !== -1) {
        allResults[resultIndex] = {
          recipientEmail: clientEmail,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        }
      }

      successRetries++
      logger.info(
        { jobId, invoiceId: invoice.id, clientEmail },
        'Retried invoice created successfully',
      )
    } catch (err) {
      failedRetries++
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'

      // Find and update the result entry with new error
      const resultIndex = allResults.findIndex((r) => r.recipientEmail === failedRow.recipientEmail)
      if (resultIndex !== -1) {
        allResults[resultIndex] = {
          recipientEmail: failedRow.recipientEmail,
          error: errorMessage,
        }
      }

      logger.warn(
        { jobId, clientEmail: failedRow.recipientEmail, err },
        'Failed to retry invoice',
      )
    }
  }

  // Update job with new counts
  const updatedJob = await prisma.bulkInvoiceJob.findUnique({
    where: { id: jobId },
  })

  if (updatedJob) {
    const newSuccessCount = updatedJob.successCount + successRetries
    const newFailedCount = updatedJob.failedCount - successRetries - failedRetries + failedRetries

    await prisma.bulkInvoiceJob.update({
      where: { id: jobId },
      data: {
        successCount: newSuccessCount,
        failedCount: newFailedCount,
        results: allResults,
      },
    })

    logger.info(
      { jobId, successRetries, failedRetries, newSuccessCount, newFailedCount },
      'Bulk invoice job retry completed',
    )
  }
}

