import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_SOURCE_TYPES = ['employment', 'savings', 'inheritance', 'investment', 'business', 'other'] as const
type SourceType = (typeof ALLOWED_SOURCE_TYPES)[number]

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function isValidSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && ALLOWED_SOURCE_TYPES.includes(value as SourceType)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * GET /api/compliance/source-of-funds
 * Get the source of funds declaration for the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const declaration = await prisma.sourceOfFundsDeclaration.findUnique({
      where: { userId: user.id },
    })

    if (!declaration) {
      return NextResponse.json({ error: 'Source of funds declaration not found' }, { status: 404 })
    }

    return NextResponse.json({
      declaration: {
        id: declaration.id,
        userId: declaration.userId,
        sourceType: declaration.sourceType,
        details: declaration.details,
        monthlyVolumeUsdc: declaration.monthlyVolumeUsdc ? Number(declaration.monthlyVolumeUsdc) : null,
        annualIncomeUsdc: declaration.annualIncomeUsdc ? Number(declaration.annualIncomeUsdc) : null,
        createdAt: declaration.createdAt.toISOString(),
        updatedAt: declaration.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/compliance/source-of-funds error')
    return NextResponse.json({ error: 'Failed to fetch source of funds declaration' }, { status: 500 })
  }
}

/**
 * POST /api/compliance/source-of-funds
 * Create or update the source of funds declaration for the authenticated user.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { sourceType, details, monthlyVolumeUsdc, annualIncomeUsdc } = payload

    if (!isValidSourceType(sourceType)) {
      return NextResponse.json(
        { error: `sourceType must be one of: ${ALLOWED_SOURCE_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    if (typeof details !== 'string' || !details.trim()) {
      return NextResponse.json({ error: 'details is required and must be non-empty' }, { status: 400 })
    }

    if (monthlyVolumeUsdc !== undefined && monthlyVolumeUsdc !== null) {
      if (!isFiniteNumber(monthlyVolumeUsdc) || monthlyVolumeUsdc < 0) {
        return NextResponse.json({ error: 'monthlyVolumeUsdc must be a non-negative number' }, { status: 400 })
      }
    }

    if (annualIncomeUsdc !== undefined && annualIncomeUsdc !== null) {
      if (!isFiniteNumber(annualIncomeUsdc) || annualIncomeUsdc < 0) {
        return NextResponse.json({ error: 'annualIncomeUsdc must be a non-negative number' }, { status: 400 })
      }
    }

    const declaration = await prisma.sourceOfFundsDeclaration.upsert({
      where: { userId: user.id },
      update: {
        sourceType,
        details: details.trim(),
        monthlyVolumeUsdc: monthlyVolumeUsdc !== undefined && monthlyVolumeUsdc !== null ? monthlyVolumeUsdc : undefined,
        annualIncomeUsdc: annualIncomeUsdc !== undefined && annualIncomeUsdc !== null ? annualIncomeUsdc : undefined,
      },
      create: {
        userId: user.id,
        sourceType,
        details: details.trim(),
        monthlyVolumeUsdc: monthlyVolumeUsdc !== undefined && monthlyVolumeUsdc !== null ? monthlyVolumeUsdc : undefined,
        annualIncomeUsdc: annualIncomeUsdc !== undefined && annualIncomeUsdc !== null ? annualIncomeUsdc : undefined,
      },
    })

    return NextResponse.json(
      {
        declaration: {
          id: declaration.id,
          userId: declaration.userId,
          sourceType: declaration.sourceType,
          details: declaration.details,
          monthlyVolumeUsdc: declaration.monthlyVolumeUsdc ? Number(declaration.monthlyVolumeUsdc) : null,
          annualIncomeUsdc: declaration.annualIncomeUsdc ? Number(declaration.annualIncomeUsdc) : null,
          createdAt: declaration.createdAt.toISOString(),
          updatedAt: declaration.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/compliance/source-of-funds error')
    return NextResponse.json({ error: 'Failed to save source of funds declaration' }, { status: 500 })
  }
}
