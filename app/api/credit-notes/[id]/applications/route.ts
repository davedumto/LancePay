import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parsePositiveMoney } from '@/lib/money'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    const creditNote = await prisma.creditNote.findFirst({
      where: { id, userId: user.id },
      select: { id: true, amount: true },
    })
    if (!creditNote) return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })

    const applications = await prisma.creditNoteApplication.findMany({
      where: { creditNoteId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, creditNoteId: true, invoiceId: true, amount: true, createdAt: true },
    })
    const applied = applications.reduce((total, application) => total.plus(application.amount), new Decimal(0))
    return NextResponse.json({
      applications: applications.map((application) => ({
        ...application,
        amount: application.amount.toNumber(),
        createdAt: application.createdAt.toISOString(),
      })),
      remainingBalance: Math.max(0, creditNote.amount.minus(applied).toNumber()),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/credit-notes/[id]/applications error')
    return NextResponse.json({ error: 'Failed to fetch credit note applications' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const payload = (body ?? {}) as Record<string, unknown>
    const amount = parsePositiveMoney(payload.amount)
    if (!amount) return NextResponse.json({ error: 'amount must be a positive amount with at most 2 decimal places' }, { status: 400 })
    if (typeof payload.invoiceId !== 'string' || !payload.invoiceId.trim()) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const creditNote = await prisma.creditNote.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        amount: true,
        appliedAmount: true,
        currency: true,
        status: true,
        invoice: { select: { clientEmail: true } },
      },
    })
    if (!creditNote) return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })
    if (creditNote.status !== 'issued') {
      return NextResponse.json({ error: `Credit note in status '${creditNote.status}' cannot be applied` }, { status: 409 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: payload.invoiceId.trim(), userId: user.id },
      select: { id: true, amount: true, currency: true, status: true, clientEmail: true },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (!['pending', 'overdue'].includes(invoice.status)) {
      return NextResponse.json({ error: `Credit cannot be applied to a ${invoice.status} invoice` }, { status: 422 })
    }
    if (invoice.currency !== creditNote.currency || invoice.clientEmail.toLowerCase() !== creditNote.invoice.clientEmail.toLowerCase()) {
      return NextResponse.json({ error: 'Credit note and invoice must have the same client and currency' }, { status: 422 })
    }
    if (amount.gt(invoice.amount)) {
      return NextResponse.json({ error: 'Application amount exceeds the invoice balance' }, { status: 422 })
    }

    const now = new Date()
    const result = await prisma.$transaction(async (tx) => {
      const totals = await tx.creditNoteApplication.aggregate({
        where: { creditNoteId: id },
        _sum: { amount: true },
      })
      const applied = totals._sum.amount ?? new Decimal(0)
      const remaining = creditNote.amount.minus(applied)
      if (amount.gt(remaining)) return { error: 'insufficient-balance' as const, remaining }

      const nextApplied = applied.plus(amount)
      const noteUpdated = await tx.creditNote.updateMany({
        where: { id, userId: user.id, status: 'issued', appliedAmount: creditNote.appliedAmount },
        data: {
          appliedAmount: nextApplied,
          ...(nextApplied.eq(creditNote.amount) ? { status: 'applied' } : {}),
        },
      })
      if (noteUpdated.count !== 1) return { error: 'balance-changed' as const, remaining }

      const invoiceUpdated = await tx.invoice.updateMany({
        where: { id: invoice.id, userId: user.id, status: { in: ['pending', 'overdue'] }, amount: { gte: amount } },
        data: { amount: { decrement: amount }, ...(invoice.amount.eq(amount) ? { status: 'paid', paidAt: now } : {}) },
      })
      if (invoiceUpdated.count !== 1) throw new Error('Invoice balance changed during credit application')

      const application = await tx.creditNoteApplication.create({
        data: { creditNoteId: id, invoiceId: invoice.id, amount },
        select: { id: true, creditNoteId: true, invoiceId: true, amount: true, createdAt: true },
      })
      return { application, remaining: remaining.minus(amount), nextApplied }
    })

    if ('error' in result) {
      if (result.error === 'insufficient-balance') {
        return NextResponse.json({ error: 'Application amount exceeds the credit note remaining balance', remainingBalance: result.remaining.toNumber() }, { status: 422 })
      }
      return NextResponse.json({ error: 'Credit note balance changed; retry the application' }, { status: 409 })
    }

    return NextResponse.json({
      application: { ...result.application, amount: result.application.amount.toNumber(), createdAt: result.application.createdAt.toISOString() },
      remainingBalance: result.remaining.toNumber(),
      creditNoteStatus: result.nextApplied.eq(creditNote.amount) ? 'applied' : 'issued',
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/credit-notes/[id]/applications error')
    return NextResponse.json({ error: 'Failed to apply credit note' }, { status: 500 })
  }
}