import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { renderToStream } from '@react-pdf/renderer'
import type { DocumentProps } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/pdf'
import React from 'react'

export const runtime = 'nodejs'

export async function GET(
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
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const branding = await prisma.brandingSettings.findUnique({ where: { userId: user.id } })

  const stream = await renderToStream(
    React.createElement(InvoicePDF, {
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        freelancerName: user.name || user.email,
        freelancerEmail: user.email,
        clientName: invoice.clientName || 'Client',
        clientEmail: invoice.clientEmail,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
        createdAt: invoice.createdAt.toISOString(),
        paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
        paymentLink: invoice.paymentLink,
      },
      branding: branding ?? undefined,
    }) as unknown as React.ReactElement<DocumentProps>,
  )

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`,
    },
  })
}
