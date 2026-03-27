import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const page = parseInt(searchParams.get('page') || '1')
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)

  const validStatuses = ['pending', 'paid', 'overdue', 'cancelled']
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const where: any = { userId: user.id }
  if (status) where.status = status

  const total = await prisma.invoice.count({ where })
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      invoiceNumber: true,
      clientName: true,
      clientEmail: true,
      amount: true,
      currency: true,
      status: true,
      dueDate: true,
      createdAt: true,
    }
  })

  const totalPages = Math.ceil(total / limit)

  const response = {
    invoices: invoices.map(inv => ({
      ...inv,
      amount: parseFloat(inv.amount.toString())
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages
    }
  }

  return NextResponse.json(response)
}