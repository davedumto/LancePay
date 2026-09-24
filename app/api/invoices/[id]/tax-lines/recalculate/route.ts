import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

// POST /api/invoices/[id]/tax-lines/recalculate
// Recompute an invoice's tax lines using the TaxRate that is effective on the
// invoice's own date, replacing the existing lines atomically.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true, amount: true, status: true, createdAt: true },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Never change amounts owed after an invoice has been paid.
    if (invoice.status === 'paid') {
      return NextResponse.json(
        { error: 'Cannot recalculate tax lines on a paid invoice' },
        { status: 400 },
      )
    }

    // Resolve rates against the invoice's own date, not the current date.
    const invoiceDate = invoice.createdAt
    const invoiceAmount = Number(invoice.amount) || 0

    const existingLines = await prisma.invoiceTaxLine.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    })

    // For each existing tax line, find the rate effective on the invoice date.
    const newLines = await Promise.all(
      existingLines.map(async (line: { name: string; rate: unknown; taxRateId: string | null }) => {
        const effective = await prisma.taxRate.findFirst({
          where: {
            userId: user.id,
            name: line.name,
            effectiveFrom: { lte: invoiceDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: invoiceDate } }],
          },
          orderBy: { effectiveFrom: 'desc' },
        })

        const rate = effective ? Number(effective.rate) : Number(line.rate)
        const amount = Number((invoiceAmount * rate).toFixed(2))

        return {
          invoiceId,
          name: line.name,
          rate,
          amount,
          taxRateId: effective?.id ?? line.taxRateId ?? null,
        }
      }),
    )

    // Replace all tax lines atomically so recalculation never appends duplicates
    // and a failure mid-way cannot leave a partial set.
    const results = await prisma.$transaction([
      prisma.invoiceTaxLine.deleteMany({ where: { invoiceId } }),
      ...newLines.map((data) => prisma.invoiceTaxLine.create({ data })),
    ])

    const taxLines = results.slice(1)

    logger.info(
      { userId: user.id, invoiceId, count: taxLines.length },
      'POST /api/invoices/[id]/tax-lines/recalculate',
    )

    return NextResponse.json({ taxLines })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/invoices/[id]/tax-lines/recalculate error')
    return NextResponse.json({ error: 'Failed to recalculate tax lines' }, { status: 500 })
  }
}
