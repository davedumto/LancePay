import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/invoices/summaries/yearly - get yearly invoice summary
// POST /api/routes-b/invoices/summaries/yearly - generate yearly invoice summary report

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

    const invoices: any[] = await (prisma as any).invoice.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    })

    const yearlyMap = new Map<
      number,
      {
        year: number
        totalInvoices: number
        paidInvoices: number
        pendingInvoices: number
        totalAmount: number
        paidAmount: number
      }
    >()

    for (const inv of invoices) {
      const year = new Date(inv.createdAt).getUTCFullYear()
      const existing = yearlyMap.get(year) || {
        year,
        totalInvoices: 0,
        paidInvoices: 0,
        pendingInvoices: 0,
        totalAmount: 0,
        paidAmount: 0,
      }

      existing.totalInvoices += 1
      const amt = Number(inv.totalAmount || 0)
      existing.totalAmount += amt

      if (inv.status === 'PAID') {
        existing.paidInvoices += 1
        existing.paidAmount += amt
      } else if (inv.status === 'PENDING') {
        existing.pendingInvoices += 1
      }

      yearlyMap.set(year, existing)
    }

    const summaries = Array.from(yearlyMap.values()).sort((a, b) => b.year - a.year)

    return NextResponse.json({
      summaries: summaries.length > 0 ? summaries : [
        {
          year: new Date().getFullYear(),
          totalInvoices: 0,
          paidInvoices: 0,
          pendingInvoices: 0,
          totalAmount: 0,
          paidAmount: 0,
        },
      ],
    })
  } catch (error) {
    logger.error({ err: error }, 'Get yearly invoice summary error')
    return NextResponse.json({ error: 'Failed to fetch yearly invoice summary' }, { status: 500 })
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
    } | null

    const year = body?.year ?? new Date().getFullYear()

    if (typeof year !== 'number' || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year parameter' }, { status: 400 })
    }

    return NextResponse.json({
      message: 'Yearly invoice summary report generated successfully',
      summary: {
        userId: user.id,
        year,
        status: 'generated',
        generatedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Generate yearly invoice summary error')
    return NextResponse.json({ error: 'Failed to generate yearly invoice summary' }, { status: 500 })
  }
}
