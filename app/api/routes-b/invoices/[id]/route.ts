import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createEntityEtag, ifMatchSatisfied } from '../../_lib/etag'

function isValidIsoDate(value: string) {
  const date = new Date(value)
  return !Number.isNaN(date.getTime())
}

async function GETHandler(
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
    select: {
      id: true,
      userId: true,
      invoiceNumber: true,
      clientEmail: true,
      clientName: true,
      description: true,
      amount: true,
      currency: true,
      status: true,
      paymentLink: true,
      dueDate: true,
      paidAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const etag = createEntityEtag(invoice.id, invoice.updatedAt)
  const response = NextResponse.json({
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      clientName: invoice.clientName,
      clientEmail: invoice.clientEmail,
      description: invoice.description,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      status: invoice.status,
      paymentLink: invoice.paymentLink,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      createdAt: invoice.createdAt,
    },
  })
  response.headers.set('ETag', etag)
  return response
}

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

  const requester = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!requester) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const ifMatchHeader = request.headers.get('if-match')
  if (!ifMatchHeader) {
    return NextResponse.json({ error: 'If-Match header is required' }, { status: 428 })
  }
  const wildcardMatch = ifMatchHeader.trim() === '*'
  if (wildcardMatch && requester.role.toLowerCase() !== 'admin') {
    return NextResponse.json({ error: 'Wildcard If-Match is admin only' }, { status: 403 })
  }

  const ownedInvoice = await prisma.invoice.findFirst({
    where: { id, userId: requester.id },
    select: { id: true, status: true, updatedAt: true },
  })

  if (!ownedInvoice) {
    const existingInvoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true },
    })

    if (existingInvoice) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (ownedInvoice.status !== 'pending') {
    return NextResponse.json({ error: 'Only pending invoices can be edited' }, { status: 422 })
  }

  if (!wildcardMatch) {
    const currentEtag = createEntityEtag(ownedInvoice.id, ownedInvoice.updatedAt)
    if (!ifMatchSatisfied(ifMatchHeader, currentEtag)) {
      return NextResponse.json({ error: 'ETag mismatch' }, { status: 412 })
    }
  }

  const body = await request.json()

  const updateData: {
    description?: string
    amount?: number
    dueDate?: Date | null
    clientName?: string
  } = {}

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.trim() === '') {
      return NextResponse.json({ error: 'description must be a non-empty string' }, { status: 400 })
    }
    if (body.description.length > 500) {
      return NextResponse.json({ error: 'description must be 500 characters or fewer' }, { status: 400 })
    }
    updateData.description = body.description.trim()
  }

  if (body.amount !== undefined) {
    if (typeof body.amount !== 'number' || Number.isNaN(body.amount) || body.amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    updateData.amount = body.amount
  }

  if (body.dueDate !== undefined) {
    if (body.dueDate === null) {
      updateData.dueDate = null
    } else if (typeof body.dueDate === 'string' && isValidIsoDate(body.dueDate)) {
      updateData.dueDate = new Date(body.dueDate)
    } else {
      return NextResponse.json(
        { error: 'dueDate must be a valid ISO date string or null' },
        { status: 400 },
      )
    }
  }

  if (body.clientName !== undefined) {
    if (typeof body.clientName !== 'string') {
      return NextResponse.json({ error: 'clientName must be a string' }, { status: 400 })
    }
    if (body.clientName.length > 100) {
      return NextResponse.json({ error: 'clientName must be 100 characters or fewer' }, { status: 400 })
    }
    updateData.clientName = body.clientName
  }

  const updatedInvoice = await prisma.invoice.update({
    where: { id: ownedInvoice.id },
    data: updateData,
    select: {
      id: true,
      invoiceNumber: true,
      description: true,
      amount: true,
      status: true,
      updatedAt: true,
      dueDate: true,
      clientName: true,
      clientEmail: true,
      currency: true,
      paymentLink: true,
      paidAt: true,
      createdAt: true,
    },
  })

  return NextResponse.json({ ...updatedInvoice, amount: Number(updatedInvoice.amount) })
}

export const GET = withRequestId(GETHandler)
export const PATCH = withRequestId(PATCHHandler)
