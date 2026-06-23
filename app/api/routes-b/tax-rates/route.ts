import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/tax-rates — list the authenticated user's tax rates ──
// ── POST /api/routes-b/tax-rates — create a new tax rate ──

const MAX_NAME_LENGTH = 100
const MAX_DESC_LENGTH = 300
const MAX_RATE = 100
const MIN_RATE = 0

type TaxRateDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  updateMany: (args: Record<string, unknown>) => Promise<unknown>
}

function getTaxRateDelegate(): TaxRateDelegate {
  return (prisma as unknown as { taxRate: TaxRateDelegate }).taxRate
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const taxRates = await getTaxRateDelegate().findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        rate: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ taxRates })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/tax-rates error')
    return NextResponse.json({ error: 'Failed to list tax rates' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as
      | { name?: string; description?: string; rate?: number; isDefault?: boolean }
      | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { name, description, rate, isDefault } = body

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

    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      return NextResponse.json({ error: 'rate must be a number' }, { status: 400 })
    }
    if (rate < MIN_RATE || rate > MAX_RATE) {
      return NextResponse.json(
        { error: `rate must be between ${MIN_RATE} and ${MAX_RATE}` },
        { status: 400 },
      )
    }

    const makeDefault = isDefault === true
    const delegate = getTaxRateDelegate()

    // If the new rate should be the default, clear any existing default for this user first.
    if (makeDefault) {
      await delegate.updateMany({
        where: { userId: user.id, isDefault: true },
        data: { isDefault: false },
      })
    }

    const taxRate = await delegate.create({
      data: {
        userId: user.id,
        name: trimmedName,
        description: trimmedDesc || null,
        rate: rate.toString(),
        isDefault: makeDefault,
      },
      select: {
        id: true,
        name: true,
        description: true,
        rate: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ taxRate }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/tax-rates error')
    return NextResponse.json({ error: 'Failed to create tax rate' }, { status: 500 })
  }
}
