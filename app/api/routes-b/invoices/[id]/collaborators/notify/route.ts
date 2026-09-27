import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// POST /api/routes-b/invoices/[id]/collaborators/notify — notify all collaborators on an invoice

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const db = prisma as unknown as {
  invoice: {
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  }
  invoiceCollaborator: {
    findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  }
  notification: {
    createMany: (args: Record<string, unknown>) => Promise<{ count: number }>
  }
}

export async function POST(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const {} = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await db.invoice.findFirst({
      where: { id, ownerId: user.id },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => ({}))) as { message?: string }
    const message = typeof body.message === 'string' ? body.message.trim() || null : null

    const collaborators = await db.invoiceCollaborator.findMany({
      where: { invoiceId: id },
      select: { userId: true },
    })

    if (collaborators.length === 0) {
      return NextResponse.json({ notified: 0, message: 'No collaborators to notify' })
    }

    const { count } = await db.notification.createMany({
      data: collaborators.map((c) => ({
        userId: c.userId as string,
        type: 'invoice_collaborator_notification',
        referenceId: id,
        body: message,
      })),
    })

    logger.info({ userId: user.id, invoiceId: id, count }, 'POST /api/routes-b/invoices/[id]/collaborators/notify')
    return NextResponse.json({ notified: count })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/collaborators/notify error')
    return NextResponse.json({ error: 'Failed to notify collaborators' }, { status: 500 })
  }
}
