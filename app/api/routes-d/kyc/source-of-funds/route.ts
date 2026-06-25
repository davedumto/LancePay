import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '../../_shared/logger'
import { getAuthenticatedUser } from '../../_shared/auth'

const SOURCE_TYPES = [
  'salary',
  'business_income',
  'investments',
  'savings',
  'inheritance',
  'gift',
  'other',
] as const

const SourceOfFundsSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  details: z.string().trim().min(10).max(1000),
  monthlyVolumeUsdc: z.number().positive().max(1_000_000).optional(),
  annualIncomeUsdc: z.number().positive().max(10_000_000).optional(),
})

type SourceOfFundsDelegate = {
  upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getDeclarationDelegate(): SourceOfFundsDelegate {
  return (prisma as unknown as { sourceOfFundsDeclaration: SourceOfFundsDelegate }).sourceOfFundsDeclaration
}

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
      body = {}
    }

    const parsed = SourceOfFundsSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.format() },
        { status: 400 },
      )
    }

    const declaration = await getDeclarationDelegate().upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        sourceType: parsed.data.sourceType,
        details: parsed.data.details,
        monthlyVolumeUsdc: parsed.data.monthlyVolumeUsdc ?? null,
        annualIncomeUsdc: parsed.data.annualIncomeUsdc ?? null,
      },
      update: {
        sourceType: parsed.data.sourceType,
        details: parsed.data.details,
        monthlyVolumeUsdc: parsed.data.monthlyVolumeUsdc ?? null,
        annualIncomeUsdc: parsed.data.annualIncomeUsdc ?? null,
      },
      select: {
        id: true,
        sourceType: true,
        details: true,
        monthlyVolumeUsdc: true,
        annualIncomeUsdc: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ declaration }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/kyc/source-of-funds error')
    return NextResponse.json({ error: 'Failed to submit source-of-funds declaration' }, { status: 500 })
  }
}
