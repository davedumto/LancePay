import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (invoice.status !== 'pending') {
    return NextResponse.json({ error: 'Only pending invoices can be edited' }, { status: 422 })
  }

  const body = await request.json()

  if (body.amount === undefined) {
    return NextResponse.json({ error: 'amount is required' }, { status: 400 })
  }

  if (typeof body.amount !== 'number' || Number.isNaN(body.amount) || body.amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: { amount: body.amount },
    select: { id: true, amount: true, currency: true, status: true, updatedAt: true },
  })

  return NextResponse.json({ ...updated, amount: Number(updated.amount) })
}

export const PATCH = withRequestId(PATCHHandler)
