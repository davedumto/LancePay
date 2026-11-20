import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { createInvoiceSchema } from '@/lib/validations'
import { withInvoiceNumberRetry } from '@/lib/utils'
import { z } from 'zod'

const bulkInvoiceJobSchema = z.object({
  recipients: z.array(createInvoiceSchema),
  totalCount: z.number().int().positive(),
})

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

export async function GET(request: NextRequest) {
  const auth = await resolveUser(request)
  if ('error' in auth) return auth.error

  const jobs = await prisma.bulkInvoiceJob.findMany({
    where: { userId: auth.user.id },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      totalCount: job.totalCount,
      successCount: job.successCount,
      failedCount: job.failedCount,
      progress:
        job.totalCount > 0
          ? Math.round(((job.successCount + job.failedCount) / job.totalCount) * 100)
          : 0,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() || null,
    })),
  })
}

export async function POST(request: NextRequest) {
  const auth = await resolveUser(request)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = bulkInvoiceJobSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { recipients, totalCount } = parsed.data

  if (recipients.length !== totalCount) {
    return NextResponse.json(
      {
        error: `totalCount (${totalCount}) does not match the number of recipients supplied (${recipients.length})`,
      },
      { status: 400 },
    )
  }

  // Create the job with default status and leave completedAt null
  const job = await prisma.bulkInvoiceJob.create({
    data: {
      userId: auth.user.id,
      status: 'processing',
      totalCount,
      successCount: 0,
      failedCount: 0,
      results: [],
    },
  })

  logger.info(
    { userId: auth.user.id, jobId: job.id, totalCount },
    'Bulk invoice job created',
  )

  // Fire-and-forget processing of the job
  processJobAsync(job.id, auth.user.id, recipients).catch((err) => {
    logger.error({ jobId: job.id, err }, 'processJobAsync failed')
  })

  return NextResponse.json(
    {
      job: {
        id: job.id,
        status: job.status,
        totalCount: job.totalCount,
        successCount: job.successCount,
        failedCount: job.failedCount,
        progress: 0,
        createdAt: job.createdAt.toISOString(),
        completedAt: null,
      },
    },
    { status: 201 },
  )
}

async function processJobAsync(
  jobId: string,
  userId: string,
  recipients: z.infer<typeof createInvoiceSchema>[],
) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lancepay.app'
  const results: Array<{
    recipientEmail: string
    invoiceId?: string
    invoiceNumber?: string
    error?: string
  }> = []
  let successCount = 0
  let failedCount = 0

  for (const recipient of recipients) {
    try {
      const { clientEmail, clientName, description, amount, currency, dueDate } = recipient

      const paymentLinkBase = `${baseUrl}/pay/`

      // Auto-link client if they have a LancePay account
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
            clientName: clientName || null,
            description,
            amount,
            currency,
            paymentLink: `${paymentLinkBase}${invoiceNumber}`,
            dueDate: dueDate ? new Date(dueDate) : null,
            clientId: clientUser?.id || null,
          },
        }),
      )

      results.push({
        recipientEmail: clientEmail.toLowerCase(),
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      })
      successCount++

      logger.info(
        { jobId, invoiceId: invoice.id, recipientEmail: clientEmail },
        'Invoice created in bulk job',
      )
    } catch (err) {
      failedCount++
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      results.push({
        recipientEmail: recipient.clientEmail.toLowerCase(),
        error: errorMessage,
      })
      logger.warn(
        { jobId, recipientEmail: recipient.clientEmail, err },
        'Failed to create invoice in bulk job',
      )
    }
  }

  // Update job with final results
  const completedAt = new Date()
  await prisma.bulkInvoiceJob.update({
    where: { id: jobId },
    data: {
      status: 'completed',
      successCount,
      failedCount,
      results,
      completedAt,
    },
  })

  logger.info(
    { jobId, totalCount: recipients.length, successCount, failedCount },
    'Bulk invoice job completed',
  )
}

