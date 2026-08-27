import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { logger } from '@/lib/logger'

// POST /api/routes-b/quotes/[id]/convert — convert an accepted quote into a
// real invoice. Ownership-checked; a quote can only be converted once.

const NON_CONVERTIBLE_STATUSES = new Set(['converted', 'declined', 'expired'])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const quote = await prisma.quote.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        invoiceId: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
      },
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }
    if (quote.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (NON_CONVERTIBLE_STATUSES.has(quote.status) || quote.invoiceId) {
      return NextResponse.json(
        { error: `Quote with status "${quote.status}" cannot be converted` },
        { status: 422 },
      )
    }

    const invoiceNumber = generateInvoiceNumber()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
    const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

    // Auto-link client if they have a LancePay account, matching the
    // convention in app/api/invoices POST.
    const clientUser = await prisma.user.findUnique({
      where: { email: quote.clientEmail.toLowerCase() },
      select: { id: true },
    })

    const invoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientEmail: quote.clientEmail.toLowerCase(),
        clientName: quote.clientName,
        description: quote.description,
        amount: quote.amount,
        currency: quote.currency,
        paymentLink,
        clientId: clientUser?.id || null,
      },
      select: {
        id: true,
        invoiceNumber: true,
        paymentLink: true,
        status: true,
      },
    })

    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'converted', invoiceId: invoice.id },
    })

    return NextResponse.json(
      {
        quote: { id: quote.id, status: 'converted' },
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          paymentLink: invoice.paymentLink,
          status: invoice.status,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/quotes/[id]/convert error')
    return NextResponse.json({ error: 'Failed to convert quote' }, { status: 500 })
  }
}
