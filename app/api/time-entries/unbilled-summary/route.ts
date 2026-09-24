import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * GET /api/time-entries/unbilled-summary
 *
 * Aggregates outstanding billable time grouped by project. Entries already
 * converted to an invoice (status "billed" or linked to an invoice) are
 * excluded. Projects without a configured rate are flagged rather than
 * silently estimated at zero.
 */
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

  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: user.id,
      invoiceId: null,
      status: { not: 'billed' },
    },
    select: {
      hours: true,
      project: { select: { id: true, title: true, rateUsdc: true } },
    },
  })

  interface Group {
    projectId: string | null
    projectTitle: string | null
    rateUsdc: number | null
    totalHours: number
    entryCount: number
  }

  const groups = new Map<string, Group>()

  for (const entry of entries) {
    const key = entry.project?.id ?? '__unassigned__'
    const existing = groups.get(key)
    if (existing) {
      existing.totalHours += Number(entry.hours)
      existing.entryCount += 1
    } else {
      groups.set(key, {
        projectId: entry.project?.id ?? null,
        projectTitle: entry.project?.title ?? null,
        rateUsdc: entry.project?.rateUsdc != null ? Number(entry.project.rateUsdc) : null,
        totalHours: Number(entry.hours),
        entryCount: 1,
      })
    }
  }

  const projects = Array.from(groups.values()).map((group) => {
    const missingRate = group.rateUsdc == null
    return {
      projectId: group.projectId,
      projectTitle: group.projectTitle,
      rateUsdc: group.rateUsdc,
      totalHours: Number(group.totalHours.toFixed(2)),
      entryCount: group.entryCount,
      // Flag rather than compute zero when no rate is configured.
      missingRate,
      estimatedAmount: missingRate
        ? null
        : Number((group.totalHours * (group.rateUsdc as number)).toFixed(2)),
    }
  })

  projects.sort((a, b) => (b.totalHours ?? 0) - (a.totalHours ?? 0))

  const totalUnbilledHours = projects.reduce((sum, p) => sum + p.totalHours, 0)
  const totalEstimatedAmount = projects.reduce(
    (sum, p) => sum + (p.estimatedAmount ?? 0),
    0,
  )

  return NextResponse.json({
    projects,
    totalUnbilledHours: Number(totalUnbilledHours.toFixed(2)),
    totalEstimatedAmount: Number(totalEstimatedAmount.toFixed(2)),
    hasUnratedProjects: projects.some((p) => p.missingRate),
  })
}
