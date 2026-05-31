import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import {
  LineItemNotFoundError,
  planPatchItem,
  planRemoveItem,
  validateItemPatch,
} from '../../../../_lib/invoice-line-items'

async function authorizeInvoiceAccess(request: NextRequest, invoiceId: string) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { ok: false as const, response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, userId: true, status: true },
  })
  if (!invoice) {
    return { ok: false as const, response: NextResponse.json({ error: 'Invoice not found' }, { status: 404 }) }
  }
  if (invoice.userId !== user.id) {
    return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  return { ok: true as const, user, invoice }
}

async function PATCHHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params
  const auth = await authorizeInvoiceAccess(request, id)
  if (!auth.ok) return auth.response

  if (auth.invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Only pending invoices can be edited', code: 'INVOICE_NOT_EDITABLE' },
      { status: 422 },
    )
  }

  const body = await request.json().catch(() => null)
  const validated = validateItemPatch(body)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }

  let plan
  try {
    plan = planPatchItem(id, itemId, validated.value)
  } catch (error) {
    if (error instanceof LineItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id },
      data: { amount: plan.totals.total },
    })
  })
  plan.commit()

  return NextResponse.json({ item: plan.item, totals: plan.totals })
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params
  const auth = await authorizeInvoiceAccess(request, id)
  if (!auth.ok) return auth.response

  if (auth.invoice.status !== 'pending') {
    return NextResponse.json(
      { error: 'Only pending invoices can be edited', code: 'INVOICE_NOT_EDITABLE' },
      { status: 422 },
    )
  }

  let plan
  try {
    plan = planRemoveItem(id, itemId)
  } catch (error) {
    if (error instanceof LineItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id },
      data: { amount: plan.totals.total },
    })
  })
  plan.commit()

  return NextResponse.json({ totals: plan.totals })
}

export const PATCH = withRequestId(PATCHHandler)
export const DELETE = withRequestId(DELETEHandler)
