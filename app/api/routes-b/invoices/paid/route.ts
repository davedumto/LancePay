import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getArchiveFilter, parseIncludeArchivedParam } from '../../_lib/invoice-archive'

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const includeArchived = parseIncludeArchivedParam(searchParams.get('includeArchived'))

  const parsedPage = parseInt(searchParams.get('page') || '1', 10)
  const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage

  const parsedLimit = parseInt(searchParams.get('limit') || '20', 10)
  const limit = Math.min(50, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit))

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where: { userId: user.id, status: 'paid', ...getArchiveFilter(includeArchived) },
      orderBy: { paidAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        paidAt: true,
        createdAt: true,
      },
    }),
    prisma.invoice.count({ where: { userId: user.id, status: 'paid', ...getArchiveFilter(includeArchived) } }),
  ])

  return NextResponse.json({
    invoices: invoices.map(invoice => ({
      ...invoice,
      amount: Number(invoice.amount),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

export const GET = withRequestId(GETHandler)
