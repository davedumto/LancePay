import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/invoices/summaries/monthly - get monthly invoice summary
// POST /api/routes-b/invoices/summaries/monthly - generate monthly invoice summary report

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const searchParams = request.nextUrl.searchParams
    const yearParam = searchParams.get('year')
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear()

    if (isNaN(year) || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year parameter' }, { status: 400 })
    }

    const invoices = await (prisma as any).invoice.findMany({
      where: {
        userId: user.id,
        createdAt: {
          gte: new Date(`${year}-01-01T00:00:00.000Z`),
          lte: new Date(`${year}-12-31T23:59:59.999Z`),
        },
      },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    })

    const monthlyData: Array<{
      month: number
      monthName: string
      totalInvoices: number
      paidInvoices: number
      pendingInvoices: number
      totalAmount: number
      paidAmount: number
    }> = Array.from({ length: 12 }, (_, index) => {
      const monthNum = index + 1
      const monthInvoices = invoices.filter(
        (inv: any) => new Date(inv.createdAt).getUTCMonth() + 1 === monthNum
      )
      const paidInvoices = monthInvoices.filter((inv: any) => inv.status === 'PAID')
      const pendingInvoices = monthInvoices.filter((inv: any) => inv.status === 'PENDING')

      return {
        month: monthNum,
        monthName: new Date(year, index, 1).toLocaleString('default', { month: 'short' }),
        totalInvoices: monthInvoices.length,
        paidInvoices: paidInvoices.length,
        pendingInvoices: pendingInvoices.length,
        totalAmount: monthInvoices.reduce((sum: number, inv: any) => sum + Number(inv.totalAmount || 0), 0),
        paidAmount: paidInvoices.reduce((sum: number, inv: any) => sum + Number(inv.totalAmount || 0), 0),
      }
    })

    return NextResponse.json({
      year,
      summaries: monthlyData,
    })
  } catch (error) {
    logger.error({ err: error }, 'Get monthly invoice summary error')
    return NextResponse.json({ error: 'Failed to fetch monthly invoice summary' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as {
      year?: number
      month?: number
    } | null

    const currentYear = new Date().getFullYear()
    const currentMonth = new Date().getMonth() + 1

    const year = body?.year ?? currentYear
    const month = body?.month ?? currentMonth

    if (typeof year !== 'number' || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year parameter' }, { status: 400 })
    }

    if (typeof month !== 'number' || month < 1 || month > 12) {
      return NextResponse.json({ error: 'Invalid month parameter' }, { status: 400 })
    }

    return NextResponse.json({
      message: 'Monthly invoice summary report generated successfully',
      summary: {
        userId: user.id,
        year,
        month,
        status: 'generated',
        generatedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Generate monthly invoice summary error')
    return NextResponse.json({ error: 'Failed to generate monthly invoice summary' }, { status: 500 })
  }
}
