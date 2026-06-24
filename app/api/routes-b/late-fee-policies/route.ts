import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/late-fee-policies — list the authenticated user's late-fee policies ──
// ── POST /api/routes-b/late-fee-policies — create a new late-fee policy ──

const MAX_NAME_LENGTH = 100
const MAX_DESC_LENGTH = 500
const MAX_GRACE_DAYS = 365
const MAX_FEE_PERCENT = 100
const MIN_FEE_PERCENT = 0

type LateFeePolicy = {
  id: string
  userId: string
  name: string
  description: string | null
  gracePeriodDays: number
  feePercent: number
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

type LateFeeDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<LateFeePolicy[]>
  create: (args: Record<string, unknown>) => Promise<LateFeePolicy>
  updateMany: (args: Record<string, unknown>) => Promise<unknown>
}

function getLateFeeDelegate(): LateFeeDelegate {
  return (prisma as unknown as { lateFeePolicy: LateFeeDelegate }).lateFeePolicy
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const policies = await getLateFeeDelegate().findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        gracePeriodDays: true,
        feePercent: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ policies })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/late-fee-policies error')
    return NextResponse.json({ error: 'Failed to list late-fee policies' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as {
      name?: string
      description?: string
      gracePeriodDays?: number
      feePercent?: number
      isDefault?: boolean
    } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { name, description, gracePeriodDays, feePercent, isDefault } = body

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const trimmedName = name.trim()
    if (trimmedName.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (typeof description !== 'undefined' && typeof description !== 'string') {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 })
    }
    const trimmedDesc = description?.trim()
    if (trimmedDesc && trimmedDesc.length > MAX_DESC_LENGTH) {
      return NextResponse.json(
        { error: `description must be at most ${MAX_DESC_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (typeof gracePeriodDays !== 'number' || !Number.isInteger(gracePeriodDays)) {
      return NextResponse.json({ error: 'gracePeriodDays must be an integer' }, { status: 400 })
    }
    if (gracePeriodDays < 0 || gracePeriodDays > MAX_GRACE_DAYS) {
      return NextResponse.json(
        { error: `gracePeriodDays must be between 0 and ${MAX_GRACE_DAYS}` },
        { status: 400 },
      )
    }

    if (typeof feePercent !== 'number' || !Number.isFinite(feePercent)) {
      return NextResponse.json({ error: 'feePercent must be a number' }, { status: 400 })
    }
    if (feePercent < MIN_FEE_PERCENT || feePercent > MAX_FEE_PERCENT) {
      return NextResponse.json(
        { error: `feePercent must be between ${MIN_FEE_PERCENT} and ${MAX_FEE_PERCENT}` },
        { status: 400 },
      )
    }

    const makeDefault = isDefault === true
    const delegate = getLateFeeDelegate()

    if (makeDefault) {
      await delegate.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      })
    }

    const policy = await delegate.create({
      data: {
        userId: user.id,
        name: trimmedName,
        description: trimmedDesc || null,
        gracePeriodDays,
        feePercent,
        isDefault: makeDefault,
      },
      select: {
        id: true,
        name: true,
        description: true,
        gracePeriodDays: true,
        feePercent: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ policy }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/late-fee-policies error')
    return NextResponse.json({ error: 'Failed to create late-fee policy' }, { status: 500 })
  }
}
