import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/routes-b/invoices/[id]/tax-lines/[lineId] — remove an invoice tax line

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

async function findOwnedInvoice(invoiceId: string, userId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true },
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; lineId: string } | Promise<{ id: string; lineId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId, lineId } = await Promise.resolve(params)

    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    if (!lineId || !lineId.trim()) {
      return NextResponse.json({ error: 'Tax line ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const taxLine = await prisma.invoiceTaxLine.findFirst({
      where: { id: lineId, invoiceId },
      select: { id: true },
    })

    if (!taxLine) {
      return NextResponse.json({ error: 'Tax line not found' }, { status: 404 })
    }

    await prisma.invoiceTaxLine.delete({
      where: { id: lineId },
    })

    logger.info(
      { userId: user.id, invoiceId, lineId },
      'DELETE /api/routes-b/invoices/[id]/tax-lines/[lineId]',
    )

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-b/invoices/[id]/tax-lines/[lineId] error')
    return NextResponse.json({ error: 'Failed to remove invoice tax line' }, { status: 500 })
  }
}
