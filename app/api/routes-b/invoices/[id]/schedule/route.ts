/**
 * POST /api/routes-b/invoices/[id]/schedule
 * Schedule an invoice to be sent at a future date.
 *
 * DELETE /api/routes-b/invoices/[id]/schedule
 * Cancel a scheduled send.
 *
 * NOTE: The dispatcher is best-effort (in-process). See _lib/scheduler.ts for limitations.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { scheduleInvoice, cancelSchedule, tickScheduler } from '../../../_lib/scheduler'

const MAX_SCHEDULE_DAYS = 365

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Tick dispatcher on each call (best-effort)
  await tickScheduler()

  const { id } = await params
  const user = await resolveUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
    select: { id: true, status: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.status === 'paid') {
    return NextResponse.json({ error: 'Cannot schedule a paid invoice' }, { status: 400 })
  }

  let body: { sendAt?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { sendAt } = body
  if (!sendAt) {
    return NextResponse.json({ error: 'sendAt is required' }, { status: 400 })
  }

  const sendAtDate = new Date(sendAt)
  if (Number.isNaN(sendAtDate.getTime())) {
    return NextResponse.json({ error: 'sendAt must be a valid ISO datetime' }, { status: 400 })
  }

  const now = new Date()
  if (sendAtDate <= now) {
    return NextResponse.json({ error: 'sendAt must be in the future' }, { status: 400 })
  }

  const maxDate = new Date(now.getTime() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000)
  if (sendAtDate > maxDate) {
    return NextResponse.json(
      { error: `sendAt cannot be more than ${MAX_SCHEDULE_DAYS} days in the future` },
      { status: 400 },
    )
  }

  // Double-schedule replaces existing
  const entry = scheduleInvoice(invoice.id, user.id, sendAtDate)

  return NextResponse.json(
    {
      invoiceId: invoice.id,
      sendAt: entry.sendAt.toISOString(),
      status: 'scheduled',
    },
    { status: 201 },
  )
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await resolveUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const cancelled = cancelSchedule(invoice.id)
  if (!cancelled) {
    return NextResponse.json({ error: 'No active schedule found for this invoice' }, { status: 404 })
  }

  return NextResponse.json({ invoiceId: invoice.id, status: 'cancelled' })
}
