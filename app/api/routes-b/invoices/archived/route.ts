import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decodeCursor, encodeCursor } from '../../_lib/cursor'

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(searchParams.get('limit') || '25', 10) || 25),
  )

  const cursorParam = searchParams.get('cursor')
  const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

  if (cursorParam && !decodedCursor) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
  }

  const where = {
    userId: user.id,
    isConfidential: true,
    ...(decodedCursor
      ? {
          OR: [
            { createdAt: { lt: new Date(decodedCursor.createdAt) } },
            {
              AND: [
                { createdAt: new Date(decodedCursor.createdAt) },
                { id: { lt: decodedCursor.id } },
              ],
            },
          ],
        }
      : {}),
  }

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      invoiceNumber: true,
      clientName: true,
      amount: true,
      currency: true,
      status: true,
      createdAt: true,
    },
  })

  const hasNext = invoices.length > limit
  const page = hasNext ? invoices.slice(0, limit) : invoices
  const last = page[page.length - 1]

  return NextResponse.json({
    invoices: page.map((invoice) => ({ ...invoice, amount: Number(invoice.amount) })),
    nextCursor:
      hasNext && last
        ? encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  })
}

export const GET = withRequestId(GETHandler)
