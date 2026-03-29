import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
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

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const where: any = { userId: user.id }
  
  if (from || to) {
    where.createdAt = {}
    if (from) {
      const fromDate = new Date(from)
      if (isNaN(fromDate.getTime())) {
        return NextResponse.json({ error: 'Invalid from date' }, { status: 400 })
      }
      where.createdAt.gte = fromDate
    }
    if (to) {
      const toDate = new Date(to)
      if (isNaN(toDate.getTime())) {
        return NextResponse.json({ error: 'Invalid to date' }, { status: 400 })
      }
      where.createdAt.lte = toDate
    }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      invoice: {
        select: {
          description: true,
        },
      },
    },
  })

  const header = 'id,type,status,amount,currency,description,createdAt\n'
  const rows = transactions
    .map((t) => {
      // Use invoice description if available, otherwise empty string
      const description = t.invoice?.description ?? ''
      return [
        t.id,
        t.type,
        t.status,
        Number(t.amount).toFixed(2),
        t.currency,
        `"${description.replace(/"/g, '""')}"`,
        t.createdAt.toISOString(),
      ].join(',')
    })
    .join('\n')

  return new NextResponse(header + rows, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="transactions.csv"',
    },
  })
}
