import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Find original invoice
    const original = await prisma.invoice.findUnique({
      where: { id: params.id },
    })

    if (!original) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Verify ownership
    if (original.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Generate new invoice number
    const invoiceCount = await prisma.invoice.count({
      where: { userId: user.id },
    })
    const newInvoiceNumber = `INV-${String(invoiceCount + 1).padStart(4, '0')}`

    // Create duplicate as draft
    const duplicate = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber: newInvoiceNumber,
        clientName: original.clientName,
        clientEmail: original.clientEmail,
        description: original.description,
        amount: original.amount,
        status: 'draft',
        dueDate: original.dueDate,
        notes: original.notes,
      },
    })

    return NextResponse.json(duplicate, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Invoice duplicate error')
    return NextResponse.json({ error: 'Failed to duplicate invoice' }, { status: 500 })
  }
}