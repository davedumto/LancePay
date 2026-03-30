import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: invoiceId } = await params

  // 1. Verify auth
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // 2. Fetch invoice and branding settings in parallel
  const [invoice, branding] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: invoiceId },
    }),
    prisma.brandingSettings.findUnique({
      where: { userId: user.id },
    }),
  ])

  // 3. Authorization and existence checks
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 4. Return merged response
  return NextResponse.json({
    preview: {
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.clientName,
        clientEmail: invoice.clientEmail,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.dueDate,
        paymentLink: invoice.paymentLink,
      },
      branding: {
        logoUrl: branding?.logoUrl ?? null,
        primaryColor: branding?.primaryColor ?? '#6366f1', // Defaulting per request
        footerText: branding?.footerText ?? null,
      },
      freelancer: {
        name: user.name,
        email: user.email,
      },
    },
  })
}
