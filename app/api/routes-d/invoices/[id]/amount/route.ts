import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { invalidateDashboardCache } from '../../../_shared/cache'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
        { error: 'Amount can only be updated on pending invoices' },
        { status: 422 },
      )
    }

    let body: { amount?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!('amount' in body)) {
      return NextResponse.json({ error: 'amount is required' }, { status: 400 })
    }

    const rawAmount = body.amount
    if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      )
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: { amount: rawAmount },
      select: {
        id: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        updatedAt: true,
      },
    })

    invalidateDashboardCache(user.id)

    return NextResponse.json(
      { ...updated, amount: Number(updated.amount) },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/invoices/[id]/amount error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}