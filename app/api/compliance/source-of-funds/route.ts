import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_SOURCE_OF_FUNDS_TYPES = new Set([
  'freelance_services',
  'consulting',
  'employment',
  'business_revenue',
  'agency_retainer',
  'royalties',
  'investments',
  'savings',
  'other',
] as const)

export type SourceOfFundsType =
  | 'freelance_services'
  | 'consulting'
  | 'employment'
  | 'business_revenue'
  | 'agency_retainer'
  | 'royalties'
  | 'investments'
  | 'savings'
  | 'other'

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

function parseOptionalNonNegativeAmount(
  raw: unknown,
  fieldName: string,
): { valid: true; value: number | null } | { valid: false; error: string; code: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, value: null }
  }
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num) || num < 0) {
    return {
      valid: false,
      error: `${fieldName} must be a non-negative number`,
      code: 'INVALID_AMOUNT_VALUE',
    }
  }
  return { valid: true, value: num }
}

function formatDeclaration(record: Record<string, any>) {
  return {
    id: record.id,
    userId: record.userId,
    sourceType: record.sourceType,
    details: record.details,
    monthlyVolumeUsdc:
      record.monthlyVolumeUsdc !== null &&
      record.monthlyVolumeUsdc !== undefined
        ? Number(record.monthlyVolumeUsdc)
        : null,
    annualIncomeUsdc:
      record.annualIncomeUsdc !== null && record.annualIncomeUsdc !== undefined
        ? Number(record.annualIncomeUsdc)
        : null,
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
    updatedAt: record.updatedAt
      ? new Date(record.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/compliance/source-of-funds
 * Retrieves the authenticated user's `SourceOfFundsDeclaration`.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const declaration = await prisma.sourceOfFundsDeclaration.findUnique({
      where: { userId: auth.user.id },
    })

    if (!declaration) {
      return NextResponse.json(
        {
          error: 'Source of funds declaration not found',
          code: 'DECLARATION_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    return NextResponse.json({
      declaration: formatDeclaration(declaration),
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/compliance/source-of-funds error')
    return NextResponse.json(
      { error: 'Failed to fetch source of funds declaration' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/compliance/source-of-funds
 * Submits or updates the user's `SourceOfFundsDeclaration`:
 * - Enforces the unique `userId` constraint by upserting rather than erroring on resubmission.
 * - Validates `sourceType` against `ALLOWED_SOURCE_OF_FUNDS_TYPES` and requires `details` to be non-empty.
 * - Validates `monthlyVolumeUsdc` and `annualIncomeUsdc` are non-negative when supplied.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const sourceType =
      typeof body.sourceType === 'string'
        ? body.sourceType.trim().toLowerCase()
        : ''
    if (
      !sourceType ||
      !ALLOWED_SOURCE_OF_FUNDS_TYPES.has(sourceType as SourceOfFundsType)
    ) {
      return NextResponse.json(
        {
          error: `sourceType must be one of: ${Array.from(ALLOWED_SOURCE_OF_FUNDS_TYPES).join(', ')}`,
          code: 'INVALID_SOURCE_TYPE',
        },
        { status: 400 },
      )
    }

    const details =
      typeof body.details === 'string' ? body.details.trim() : ''
    if (!details) {
      return NextResponse.json(
        {
          error: 'details is required and must be non-empty',
          code: 'DETAILS_REQUIRED',
        },
        { status: 400 },
      )
    }

    const monthlyCheck = parseOptionalNonNegativeAmount(
      body.monthlyVolumeUsdc,
      'monthlyVolumeUsdc',
    )
    if (!monthlyCheck.valid) {
      return NextResponse.json(
        { error: monthlyCheck.error, code: monthlyCheck.code },
        { status: 400 },
      )
    }

    const annualCheck = parseOptionalNonNegativeAmount(
      body.annualIncomeUsdc,
      'annualIncomeUsdc',
    )
    if (!annualCheck.valid) {
      return NextResponse.json(
        { error: annualCheck.error, code: annualCheck.code },
        { status: 400 },
      )
    }

    const declaration = await prisma.sourceOfFundsDeclaration.upsert({
      where: { userId: auth.user.id },
      update: {
        sourceType,
        details,
        monthlyVolumeUsdc: monthlyCheck.value,
        annualIncomeUsdc: annualCheck.value,
      },
      create: {
        userId: auth.user.id,
        sourceType,
        details,
        monthlyVolumeUsdc: monthlyCheck.value,
        annualIncomeUsdc: annualCheck.value,
      },
    })

    return NextResponse.json({
      declaration: formatDeclaration(declaration),
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/compliance/source-of-funds error')
    return NextResponse.json(
      { error: 'Failed to submit source of funds declaration' },
      { status: 500 },
    )
  }
}
