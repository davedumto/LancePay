import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const OPEN_INVOICE_STATUSES = ['pending', 'overdue'] as const

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveCreditNoteId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

function toCents(value: unknown): number {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? Math.round(num * 100) : 0
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeApplication(app: Record<string, any>) {
  return {
    id: app.id,
    creditNoteId: app.creditNoteId,
    invoiceId: app.invoiceId,
    amount: Number(app.amount),
    createdAt: app.createdAt ? new Date(app.createdAt).toISOString() : null,
  }
}

async function fetchExistingApplications(
  db: typeof prisma,
  creditNote: Record<string, any>,
): Promise<Array<Record<string, any>>> {
  if (typeof db.creditNoteApplication?.findMany === 'function') {
    const rows = await db.creditNoteApplication.findMany({
      where: { creditNoteId: creditNote.id },
      orderBy: { createdAt: 'asc' },
    })
    if (Array.isArray(rows)) {
      return rows
    }
  }
  if (Array.isArray(creditNote.applications)) {
    return creditNote.applications
  }
  return []
}

/**
 * GET /api/credit-notes/[id]/applications
 * Lists all `CreditNoteApplication` rows for a credit note and computes its remaining balance.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const creditNoteId = await resolveCreditNoteId(context)
    if (!creditNoteId) {
      return NextResponse.json(
        { error: 'Credit note ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const creditNote =
      typeof prisma.creditNote?.findUnique === 'function'
        ? await prisma.creditNote.findUnique({ where: { id: creditNoteId } })
        : await prisma.creditNote.findFirst({ where: { id: creditNoteId } })

    if (!creditNote) {
      return NextResponse.json(
        { error: 'Credit note not found' },
        { status: 404 },
      )
    }
    if (creditNote.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const applications = await fetchExistingApplications(prisma, creditNote)
    const totalCents = toCents(creditNote.amount)
    const appliedCents = applications.reduce(
      (sum, app) => sum + toCents(app.amount),
      0,
    )
    const remainingCents = Math.max(0, totalCents - appliedCents)

    return NextResponse.json({
      creditNoteId: creditNote.id,
      amount: fromCents(totalCents),
      appliedAmount: fromCents(appliedCents),
      remainingBalance: fromCents(remainingCents),
      applications: applications.map(serializeApplication),
    })
  } catch (error) {
    logger?.error?.(
      { err: error },
      'GET /api/credit-notes/[id]/applications error',
    )
    return NextResponse.json(
      { error: 'Failed to fetch credit note applications' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/credit-notes/[id]/applications
 * Applies a `CreditNote` (partially or fully) against an open invoice via `CreditNoteApplication`:
 * - Sums existing `CreditNoteApplication` rows for the credit note to compute remaining balance
 *   before allowing a new application.
 * - Rejects an application amount that would exceed the credit note's remaining balance.
 * - Supports applying the same credit note across multiple invoices in separate calls, each
 *   respecting the shrinking remaining balance.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const creditNoteId = await resolveCreditNoteId(context)
    if (!creditNoteId) {
      return NextResponse.json(
        { error: 'Credit note ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const invoiceId =
      typeof body.invoiceId === 'string' ? body.invoiceId.trim() : ''
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'invoiceId is required', code: 'INVOICE_ID_REQUIRED' },
        { status: 400 },
      )
    }

    const parsedAmount = Number(body.amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number', code: 'INVALID_AMOUNT' },
        { status: 400 },
      )
    }

    const requestedCents = toCents(parsedAmount)
    if (requestedCents <= 0) {
      return NextResponse.json(
        { error: 'amount must be at least 0.01', code: 'INVALID_AMOUNT' },
        { status: 400 },
      )
    }

    const creditNote =
      typeof prisma.creditNote?.findUnique === 'function'
        ? await prisma.creditNote.findUnique({ where: { id: creditNoteId } })
        : await prisma.creditNote.findFirst({ where: { id: creditNoteId } })

    if (!creditNote) {
      return NextResponse.json(
        { error: 'Credit note not found' },
        { status: 404 },
      )
    }
    if (creditNote.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (creditNote.status === 'voided') {
      return NextResponse.json(
        {
          error: 'Cannot apply a voided credit note',
          code: 'CREDIT_NOTE_VOIDED',
        },
        { status: 422 },
      )
    }

    const existingApplications = await fetchExistingApplications(
      prisma,
      creditNote,
    )
    const totalCreditCents = toCents(creditNote.amount)
    const existingAppliedCents = existingApplications.reduce(
      (sum, app) => sum + toCents(app.amount),
      0,
    )
    const remainingBeforeCents = Math.max(
      0,
      totalCreditCents - existingAppliedCents,
    )

    if (remainingBeforeCents <= 0 || creditNote.status === 'applied') {
      return NextResponse.json(
        {
          error: 'Credit note has no remaining balance available to apply',
          code: 'CREDIT_NOTE_EXHAUSTED',
          creditNoteAmount: fromCents(totalCreditCents),
          appliedAmount: fromCents(existingAppliedCents),
          remainingBalance: 0,
        },
        { status: 400 },
      )
    }

    if (requestedCents > remainingBeforeCents) {
      return NextResponse.json(
        {
          error:
            'Application amount exceeds the credit note remaining balance',
          code: 'INSUFFICIENT_CREDIT_NOTE_BALANCE',
          requestedAmount: fromCents(requestedCents),
          creditNoteAmount: fromCents(totalCreditCents),
          appliedAmount: fromCents(existingAppliedCents),
          remainingBalance: fromCents(remainingBeforeCents),
        },
        { status: 400 },
      )
    }

    let invoice: Record<string, any> | null = null
    if (typeof prisma.invoice?.findUnique === 'function') {
      invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    } else if (typeof prisma.invoice?.findFirst === 'function') {
      invoice = await prisma.invoice.findFirst({ where: { id: invoiceId } })
    }

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId && invoice.userId !== creditNote.userId && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (
      invoice.status &&
      !(OPEN_INVOICE_STATUSES as readonly string[]).includes(
        String(invoice.status),
      )
    ) {
      return NextResponse.json(
        {
          error: `Cannot apply credit note to an invoice with status "${invoice.status}"`,
          code: 'INVOICE_NOT_OPEN',
        },
        { status: 422 },
      )
    }

    if (
      invoice.currency &&
      creditNote.currency &&
      invoice.currency !== creditNote.currency
    ) {
      return NextResponse.json(
        {
          error: 'Invoice currency does not match credit note currency',
          code: 'CURRENCY_MISMATCH',
        },
        { status: 422 },
      )
    }

    const invoiceBalanceCents = toCents(invoice.amount)
    if (invoiceBalanceCents > 0 && requestedCents > invoiceBalanceCents) {
      return NextResponse.json(
        {
          error: 'Application amount exceeds the open invoice balance',
          code: 'EXCEEDS_INVOICE_BALANCE',
          requestedAmount: fromCents(requestedCents),
          invoiceBalance: fromCents(invoiceBalanceCents),
        },
        { status: 400 },
      )
    }

    const normalizedAmount = fromCents(requestedCents)
    const newAppliedCents = existingAppliedCents + requestedCents
    const remainingAfterCents = Math.max(0, totalCreditCents - newAppliedCents)
    const nextCreditNoteStatus =
      remainingAfterCents === 0 ? 'applied' : 'issued'

    const executeApplication = async (tx: typeof prisma) => {
      const createdApplication = await tx.creditNoteApplication.create({
        data: {
          creditNoteId: creditNote.id,
          invoiceId,
          amount: normalizedAmount,
        },
      })

      if (typeof tx.creditNote?.update === 'function') {
        await tx.creditNote.update({
          where: { id: creditNote.id },
          data: {
            appliedAmount: fromCents(newAppliedCents),
            status: nextCreditNoteStatus,
          },
        })
      }

      const nextInvoiceCents = Math.max(0, invoiceBalanceCents - requestedCents)
      const nextInvoiceStatus =
        invoiceBalanceCents > 0 && nextInvoiceCents === 0
          ? 'paid'
          : (invoice?.status ?? 'pending')

      if (typeof tx.invoice?.update === 'function' && invoiceBalanceCents > 0) {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            amount: fromCents(nextInvoiceCents),
            status: nextInvoiceStatus,
            ...(nextInvoiceStatus === 'paid' ? { paidAt: new Date() } : {}),
          },
        })
      }

      return {
        createdApplication,
        nextInvoiceBalance: fromCents(nextInvoiceCents),
        nextInvoiceStatus,
      }
    }

    const result =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx: any) => executeApplication(tx))
        : await executeApplication(prisma)

    return NextResponse.json(
      {
        application: serializeApplication(result.createdApplication),
        creditNote: {
          id: creditNote.id,
          amount: fromCents(totalCreditCents),
          appliedAmount: fromCents(newAppliedCents),
          remainingBalance: fromCents(remainingAfterCents),
          status: nextCreditNoteStatus,
        },
        invoice: {
          id: invoiceId,
          remainingBalance: result.nextInvoiceBalance,
          status: result.nextInvoiceStatus,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.(
      { err: error },
      'POST /api/credit-notes/[id]/applications error',
    )
    return NextResponse.json(
      { error: 'Failed to apply credit note' },
      { status: 500 },
    )
  }
}
