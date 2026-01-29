import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Query params
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') // pending, verified, rejected

    // Build where clause
    const where: {
      invoice: { userId: string }
      status?: string
    } = {
      invoice: { userId: user.id },
    }

    if (status && ['pending', 'verified', 'rejected'].includes(status)) {
      where.status = status
    }

    // Fetch manual payments
    const payments = await prisma.manualPayment.findMany({
      where,
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            clientEmail: true,
            amount: true,
            currency: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50, // Limit results
    })

    // Map to response format
    const response = payments.map((p) => ({
      id: p.id,
      invoiceNumber: p.invoice.invoiceNumber,
      invoiceId: p.invoice.id,
      clientName: p.clientName,
      amountPaid: Number(p.amountPaid),
      currency: p.currency,
      receiptUrl: `/api/routes-d/local/offline-verification/receipt/${p.id}`,
      status: p.status,
      notes: p.notes,
      createdAt: p.createdAt.toISOString(),
      verifiedAt: p.verifiedAt?.toISOString() || null,
      invoice: {
        number: p.invoice.invoiceNumber,
        clientEmail: p.invoice.clientEmail,
        expectedAmount: Number(p.invoice.amount),
        expectedCurrency: p.invoice.currency,
        status: p.invoice.status,
      },
    }))

    return NextResponse.json({ payments: response })
  } catch (error) {
    console.error('List manual payments error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch payments' },
      { status: 500 }
    )
  }
}
