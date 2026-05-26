import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_REASON_LENGTH = 200

async function POSTHandler(
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

  // Optional body: { reason?: string } (<= 200 chars). Tolerate an empty body.
  let reason: string | undefined
  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  if (body && typeof body === 'object' && 'reason' in body) {
    const rawReason = (body as Record<string, unknown>).reason
    if (rawReason !== undefined && rawReason !== null) {
      if (typeof rawReason !== 'string' || rawReason.length > MAX_REASON_LENGTH) {
        return NextResponse.json(
          { error: `reason must be a string of at most ${MAX_REASON_LENGTH} characters` },
          { status: 400 },
        )
      }
      reason = rawReason
    }
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
    return NextResponse.json(
      { error: 'Only pending invoices can be cancelled' },
      { status: 422 },
    )
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      ...(reason !== undefined ? { cancellationReason: reason } : {}),
    },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      cancelledAt: true,
      cancellationReason: true,
    },
  })

  return NextResponse.json(updated)
}

export const POST = withRequestId(POSTHandler)
