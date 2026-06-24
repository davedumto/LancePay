import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const VALID_REPORT_TYPES = ['aging', 'cash-flow', 'hours-billed', 'tax-summary', 'yoy'] as const
const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const

type ScheduledReportDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getScheduledReportDelegate(): ScheduledReportDelegate {
  return (prisma as unknown as { scheduledReport: ScheduledReportDelegate }).scheduledReport
}

const scheduledReportSelect = {
  id: true,
  name: true,
  description: true,
  reportType: true,
  frequency: true,
  interval: true,
  timezone: true,
  enabled: true,
  nextRunAt: true,
  lastRunAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
}

export async function GET(request: NextRequest) {
  try {
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
    const reportType = searchParams.get('reportType')

    const where: Record<string, unknown> = { userId: user.id }
    if (reportType) {
      if (!VALID_REPORT_TYPES.includes(reportType as (typeof VALID_REPORT_TYPES)[number])) {
        return NextResponse.json(
          { error: 'reportType must be one of: aging, cash-flow, hours-billed, tax-summary, yoy' },
          { status: 400 },
        )
      }
      where.reportType = reportType
    }

    const delegate = getScheduledReportDelegate()
    const scheduledReports = await delegate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: scheduledReportSelect,
    })

    return NextResponse.json({ scheduledReports })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const {
      name,
      description,
      reportType,
      frequency,
      interval = 1,
      timezone,
      enabled = true,
      metadata = {},
    } = body

    if (!name || !reportType || !frequency) {
      return NextResponse.json(
        { error: 'name, reportType, and frequency are required' },
        { status: 400 },
      )
    }

    if (!VALID_REPORT_TYPES.includes(reportType)) {
      return NextResponse.json(
        { error: 'reportType must be one of: aging, cash-flow, hours-billed, tax-summary, yoy' },
        { status: 400 },
      )
    }

    if (!VALID_FREQUENCIES.includes(frequency)) {
      return NextResponse.json(
        { error: 'frequency must be one of: daily, weekly, monthly, yearly' },
        { status: 400 },
      )
    }

    if (interval < 1) {
      return NextResponse.json(
        { error: 'interval must be a positive integer' },
        { status: 400 },
      )
    }

    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return NextResponse.json(
        { error: 'metadata must be a valid JSON object' },
        { status: 400 },
      )
    }

    const delegate = getScheduledReportDelegate()
    const existing = await delegate.findUnique({
      where: {
        userId_name: {
          userId: user.id,
          name,
        },
      },
    })

    if (existing) {
      return NextResponse.json(
        { error: 'A scheduled report with this name already exists' },
        { status: 409 },
      )
    }

    const scheduledReport = await delegate.create({
      data: {
        userId: user.id,
        name,
        description,
        reportType,
        frequency,
        interval,
        timezone,
        enabled,
        metadata,
      },
    })

    return NextResponse.json(scheduledReport, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
