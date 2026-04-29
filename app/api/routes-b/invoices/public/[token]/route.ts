/**
 * GET /api/routes-b/invoices/public/[token]
 * Read-only public view of an invoice via share token.
 * No PII, no internal IDs, no payment provider details.
 * Rate limited: 60 req/hour per token.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { lookupShareToken } from '../../../_lib/share-tokens'
import { checkRateLimit } from '../../../_lib/rate-limit'

const RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 }

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Rate limit per token
  const rl = checkRateLimit(`share:${token}`, RATE_LIMIT)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfter) },
      },
    )
  }

  const entry = lookupShareToken(token)

  if (!entry) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
  }

  if (entry.revokedAt) {
    return NextResponse.json({ error: 'Token has been revoked' }, { status: 410 })
  }

  if (new Date() > entry.expiresAt) {
    return NextResponse.json({ error: 'Token has expired' }, { status: 410 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: entry.invoiceId },
    select: {
      invoiceNumber: true,
      clientName: true,
      description: true,
      amount: true,
      currency: true,
      status: true,
      dueDate: true,
      createdAt: true,
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  // Redacted public view — no payer PII, no internal IDs, no payment provider details
  return NextResponse.json({
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    description: invoice.description,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    dueDate: invoice.dueDate,
    createdAt: invoice.createdAt,
  })
}
