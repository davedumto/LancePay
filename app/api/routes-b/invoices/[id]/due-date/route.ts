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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Due date can only be updated on pending invoices' },
      { status: 422 },
    )
  }

  let body: { dueDate?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!('dueDate' in body)) {
    return NextResponse.json({ error: 'dueDate is required' }, { status: 400 })
  }

  let dueDate: Date | null = null

  if (body.dueDate !== null) {
    if (typeof body.dueDate !== 'string') {
      return NextResponse.json({ error: 'dueDate must be a string or null' }, { status: 400 })
    }

    const parsedDate = new Date(body.dueDate)
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 })
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const normalizedDate = new Date(parsedDate)
    normalizedDate.setHours(0, 0, 0, 0)

    if (normalizedDate < today) {
      return NextResponse.json({ error: 'Due date cannot be in the past' }, { status: 400 })
    }

    dueDate = parsedDate
  }

  const updatedInvoice = await prisma.invoice.update({
    where: { id },
    data: { dueDate },
    select: {
      id: true,
      invoiceNumber: true,
      dueDate: true,
    },
  })

  return NextResponse.json(updatedInvoice, { status: 200 })
}

export const PATCH = withRequestId(PATCHHandler)
