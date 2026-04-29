/**
 * POST /api/routes-b/invoices/templates/[id]/instantiate
 * Create a real invoice from a template and advance nextRunAt.
 * Idempotent within the current cadence window (no double-create on retries).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { getTemplateStore } from '../../route'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

function advanceNextRunAt(current: Date, cadence: string): Date {
  const next = new Date(current)
  if (cadence === 'weekly') next.setDate(next.getDate() + 7)
  else if (cadence === 'monthly') next.setMonth(next.getMonth() + 1)
  else if (cadence === 'quarterly') next.setMonth(next.getMonth() + 3)
  return next
}

function cadenceWindowMs(cadence: string): number {
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000
  if (cadence === 'monthly') return 31 * 24 * 60 * 60 * 1000
  return 92 * 24 * 60 * 60 * 1000 // quarterly
}

// idempotency: track last instantiation per template
const lastInstantiated = new Map<string, { invoiceId: string; at: Date }>()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await resolveUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tpl = getTemplateStore().get(id)
  if (!tpl || tpl.userId !== user.id) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  // Idempotency: if already instantiated within this cadence window, return existing invoice
  const last = lastInstantiated.get(id)
  if (last) {
    const windowMs = cadenceWindowMs(tpl.cadence)
    if (Date.now() - last.at.getTime() < windowMs) {
      const existing = await prisma.invoice.findUnique({
        where: { id: last.invoiceId },
        select: { id: true, invoiceNumber: true, status: true, amount: true, currency: true, paymentLink: true },
      })
      if (existing) {
        return NextResponse.json({ invoice: { ...existing, amount: Number(existing.amount) }, idempotent: true })
      }
    }
  }

  // Look up client email from clientId
  const client = await prisma.user.findUnique({
    where: { id: tpl.clientId },
    select: { email: true, name: true },
  })

  const clientEmail = client?.email ?? `client-${tpl.clientId}@unknown.invalid`
  const clientName = client?.name ?? null

  const invoiceNumber = generateInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lancepay.app'
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const invoice = await prisma.invoice.create({
    data: {
      userId: user.id,
      invoiceNumber,
      clientEmail,
      clientName,
      description: tpl.name,
      amount: tpl.amount,
      currency: tpl.currency,
      paymentLink,
    },
  })

  // Advance nextRunAt
  tpl.nextRunAt = advanceNextRunAt(tpl.nextRunAt, tpl.cadence)
  tpl.updatedAt = new Date()

  lastInstantiated.set(id, { invoiceId: invoice.id, at: new Date() })

  return NextResponse.json(
    {
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        paymentLink: invoice.paymentLink,
      },
      nextRunAt: tpl.nextRunAt.toISOString(),
    },
    { status: 201 },
  )
}
