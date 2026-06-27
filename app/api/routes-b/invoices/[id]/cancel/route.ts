import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function POSTHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { id } = await context.params

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
  })
  
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Only pending invoices can be cancelled' },
      { status: 400 },
    )
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
    },
  })

  logger.info({ userId: user.id, invoiceId: id }, 'Invoice cancelled')

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    cancelledAt: updated.cancelledAt,
  })
}

export const POST = withRequestId(POSTHandler)
