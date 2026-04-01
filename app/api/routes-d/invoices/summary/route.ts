import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

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

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return {
      label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
    }
  }).reverse()

  const summary = await Promise.all(
    months.map(async ({ label, start, end }) => {
      const [issuedAgg, paidAgg] = await Promise.all([
        prisma.invoice.aggregate({
          where: {
            userId: user.id,
            createdAt: { gte: start, lte: end },
          },
          _count: { id: true },
          _sum: { amount: true },
        }),
        prisma.invoice.aggregate({
          where: {
            userId: user.id,
            status: 'paid',
            paidAt: { gte: start, lte: end },
          },
          _count: { id: true },
          _sum: { amount: true },
        }),
      ])

      return {
        month: label,
        issued: issuedAgg._count.id,
        paid: paidAgg._count.id,
        totalIssued: Number(issuedAgg._sum.amount ?? 0),
        totalPaid: Number(paidAgg._sum.amount ?? 0),
      }
    }),
  )

  return NextResponse.json({ summary })
}
