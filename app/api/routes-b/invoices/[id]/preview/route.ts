import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

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
      clientName: true,
      clientEmail: true,
      description: true,
      amount: true,
      currency: true,
      status: true,
      dueDate: true,
      paymentLink: true,
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

  return NextResponse.json({
    preview: {
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.clientName,
        clientEmail: invoice.clientEmail,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.dueDate,
        paymentLink: invoice.paymentLink,
        createdAt: invoice.createdAt,
      },
      branding: branding
        ? {
            logoUrl: branding.logoUrl,
            primaryColor: branding.primaryColor,
            footerText: branding.footerText,
          }
        : null,
    },
  })
}
