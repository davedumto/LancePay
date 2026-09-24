import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logAuditEvent, extractRequestMetadata } from '@/lib/audit'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params
  const invoice = await prisma.invoice.findUnique({
    where: { invoiceNumber: invoiceId },
    include: {
      user: { select: { name: true, wallet: { select: { address: true } } } },
    },
  })

  if (!invoice)
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  logAuditEvent(
    invoice.id,
    'invoice.viewed',
    null,
    extractRequestMetadata(request.headers),
  ).catch((error) => {
    logger.error({ err: error }, 'Failed to log invoice.viewed audit event')
  })

  return NextResponse.json({
    invoiceNumber: invoice.invoiceNumber,
    freelancerName: invoice.user.name || 'Freelancer',
    description: invoice.description,
    amount: Number(invoice.amount),
    status: invoice.status,
    dueDate: invoice.dueDate,
    walletAddress: invoice.user.wallet?.address,
  })
}
