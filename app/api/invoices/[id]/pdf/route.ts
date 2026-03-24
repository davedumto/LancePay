import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { renderToStream, type DocumentProps } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/pdf'
import React, { type JSXElementConstructor, type ReactElement } from 'react'

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

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    include: { brandingSettings: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const invoiceData = {
    invoiceNumber: invoice.invoiceNumber,
    freelancerName: user.name || 'Freelancer',
    freelancerEmail: user.email,
    clientName: invoice.clientName || 'Client',
    clientEmail: invoice.clientEmail,
    description: invoice.description,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    dueDate: invoice.dueDate?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    paidAt: invoice.paidAt?.toISOString() ?? null,
    paymentLink: invoice.paymentLink,
  }

  const branding = user.brandingSettings
    ? {
        logoUrl: user.brandingSettings.logoUrl,
        primaryColor: user.brandingSettings.primaryColor,
        footerText: user.brandingSettings.footerText,
        signatureUrl: user.brandingSettings.signatureUrl,
      }
    : undefined

  const stream = await renderToStream(
    React.createElement(InvoicePDF, { invoice: invoiceData, branding }) as unknown as ReactElement<DocumentProps, JSXElementConstructor<DocumentProps>>,
  )

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
    },
  })
}
