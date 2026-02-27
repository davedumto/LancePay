import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext, isAdminEmail } from '@/app/api/routes-d/disputes/_shared'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const { id } = await params

    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        invoice: { select: { id: true, invoiceNumber: true, amount: true, clientEmail: true, userId: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })

    const admin = isAdminEmail(auth.email)
    const isFreelancer = auth.user.id === dispute.invoice.userId
    const isClient = auth.email.toLowerCase() === dispute.invoice.clientEmail.toLowerCase()
    if (!admin && !isFreelancer && !isClient) {
      return NextResponse.json({ error: 'Not authorized to view this dispute' }, { status: 403 })
    }

    return NextResponse.json({
      dispute: {
        id: dispute.id,
        invoice: {
          id: dispute.invoice.id,
          invoiceNumber: dispute.invoice.invoiceNumber,
          amount: Number(dispute.invoice.amount),
        },
        initiatedBy: dispute.initiatedBy,
        reason: dispute.reason,
        requestedAction: dispute.requestedAction,
        status: dispute.status,
        resolution: dispute.resolution ?? undefined,
        createdAt: dispute.createdAt.toISOString(),
      },
      messages: dispute.messages.map((m: any) => ({
        id: m.id,
        senderType: m.senderType,
        senderEmail: m.senderEmail,
        message: m.message,
        attachments: (m.attachments as any) ?? [],
        createdAt: m.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'Dispute get error:')
    return NextResponse.json({ error: 'Failed to get dispute' }, { status: 500 })
  }
}

