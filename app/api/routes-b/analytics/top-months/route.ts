import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isValidTimezone } from '../../_lib/date-range'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const rawTz = url.searchParams.get('tz') ?? user.timezone ?? 'UTC'
    if (!isValidTimezone(rawTz)) {
      return NextResponse.json(
        { error: 'Invalid timezone', fields: { tz: `"${rawTz}" is not a valid IANA timezone name` } },
        { status: 400 },
      )
    }

    const paid = await prisma.invoice.findMany({
      where: { userId: user.id, status: 'paid' },
      select: { amount: true, paidAt: true },
    })

    // Group by local "YYYY-MM" in the requested timezone
    const monthly: Record<string, number> = {}
    for (const inv of paid) {
      if (!inv.paidAt) continue
      const key = inv.paidAt.toLocaleDateString('en-CA', { timeZone: rawTz }).slice(0, 7)
      monthly[key] = (monthly[key] ?? 0) + Number(inv.amount)
    }

    const topMonths = Object.entries(monthly)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([month, earned]) => ({ month, earned: Number(earned.toFixed(2)) }))

    return NextResponse.json({ topMonths, tz: rawTz })
  } catch (error) {
    console.error('Top months analytics error:', error)
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 })
  }
}
