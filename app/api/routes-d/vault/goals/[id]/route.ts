import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── PATCH /api/routes-d/vault/goals/[id] — update an existing savings goal ──
//
// Mutable fields: title, targetAmountUsdc, savingsPercentage, isActive, status.
// targetAmountUsdc and savingsPercentage are validated against the same
// invariants as goal creation. Ownership is enforced before any update lands.

const VALID_STATUSES = ['in_progress', 'completed', 'cancelled'] as const
const TITLE_MAX = 100

type Body = {
  title?: unknown
  targetAmountUsdc?: unknown
  savingsPercentage?: unknown
  isActive?: unknown
  status?: unknown
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const existing = await prisma.savingsGoal.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Savings goal not found' }, { status: 404 })
    }
    if (existing.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to update this savings goal' },
        { status: 403 },
      )
    }

    const body = (await request.json().catch(() => null)) as Body | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const data: {
      title?: string
      targetAmountUsdc?: number
      savingsPercentage?: number
      isActive?: boolean
      status?: string
    } = {}

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > TITLE_MAX) {
        return NextResponse.json(
          { error: `title must be a non-empty string ≤ ${TITLE_MAX} chars` },
          { status: 400 },
        )
      }
      data.title = body.title.trim()
    }
    if (body.targetAmountUsdc !== undefined) {
      const n = typeof body.targetAmountUsdc === 'number' ? body.targetAmountUsdc : Number(body.targetAmountUsdc)
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json(
          { error: 'targetAmountUsdc must be a positive number' },
          { status: 400 },
        )
      }
      data.targetAmountUsdc = n
    }
    if (body.savingsPercentage !== undefined) {
      const n = typeof body.savingsPercentage === 'number'
        ? body.savingsPercentage
        : Number(body.savingsPercentage)
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: 'savingsPercentage must be an integer in [0, 100]' },
          { status: 400 },
        )
      }
      data.savingsPercentage = n
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') {
        return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 })
      }
      data.isActive = body.isActive
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
        return NextResponse.json(
          { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
          { status: 400 },
        )
      }
      data.status = body.status
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const updated = await prisma.savingsGoal.update({
      where: { id },
      data,
    })

    return NextResponse.json({
      goal: {
        ...updated,
        targetAmountUsdc: Number(updated.targetAmountUsdc),
        currentAmountUsdc: Number(updated.currentAmountUsdc),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Vault goal PATCH error')
    return NextResponse.json({ error: 'Failed to update savings goal' }, { status: 500 })
  }
}
