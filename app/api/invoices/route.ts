import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoices = await prisma.invoice.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
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

  return NextResponse.json({
    invoices: invoices.map((inv: typeof invoices[number]) => ({
      ...inv,
      amount: Number(inv.amount),
    })),
  })
}

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const body = await request.json()
  const { clientEmail, clientName, description, amount, currency = 'USD', dueDate } = body

  if (!clientEmail || !description || !amount || amount <= 0) {
    return NextResponse.json(
      { error: 'clientEmail, description, and a positive amount are required' },
      { status: 400 },
    )
  }

  const invoiceNumber = generateInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  // Auto-link client if they have a LancePay account
  const clientUser = await prisma.user.findUnique({
    where: { email: clientEmail.toLowerCase() },
    select: { id: true },
  })

  const invoice = await prisma.invoice.create({
    data: {
      userId: user.id,
      invoiceNumber,
      clientEmail: clientEmail.toLowerCase(),
      clientName: clientName || null,
      description,
      amount,
      currency,
      paymentLink,
      dueDate: dueDate ? new Date(dueDate) : null,
      clientId: clientUser?.id || null,
    },
  })

  return NextResponse.json(
    {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentLink: invoice.paymentLink,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
    },
    { status: 201 },
  )
}
