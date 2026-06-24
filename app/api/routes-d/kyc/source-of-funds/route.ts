import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { Prisma } from '@prisma/client'

const VALID_SOURCE_TYPES = ['salary', 'savings', 'inheritance', 'investment', 'business_profits', 'other'] as const
const CURRENCY_REGEX = /^[A-Z]{3}$/

type Body = {
  sourceType?: string
  annualIncome?: number | string
  currency?: string
  occupation?: string
  companyName?: string
  supportingDocUrl?: string
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as Body | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { sourceType, annualIncome, currency, occupation, companyName, supportingDocUrl } = body

    if (!sourceType || !VALID_SOURCE_TYPES.includes(sourceType as typeof VALID_SOURCE_TYPES[number])) {
      return NextResponse.json(
        { error: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    if (annualIncome === undefined || annualIncome === null) {
      return NextResponse.json({ error: 'annualIncome is required' }, { status: 400 })
    }
    const incomeNum = Number(annualIncome)
    if (Number.isNaN(incomeNum) || incomeNum <= 0) {
      return NextResponse.json({ error: 'annualIncome must be a positive number' }, { status: 400 })
    }

    if (!currency || !CURRENCY_REGEX.test(currency)) {
      return NextResponse.json({ error: 'currency must be a 3-letter uppercase ISO code' }, { status: 400 })
    }

    if (!occupation || typeof occupation !== 'string' || occupation.trim().length < 2) {
      return NextResponse.json({ error: 'occupation is required (≥ 2 chars)' }, { status: 400 })
    }

    if (companyName !== undefined && (typeof companyName !== 'string' || companyName.trim().length < 2)) {
      return NextResponse.json({ error: 'companyName must be a string (≥ 2 chars)' }, { status: 400 })
    }

    if (supportingDocUrl !== undefined && (typeof supportingDocUrl !== 'string' || !supportingDocUrl.startsWith('https://'))) {
      return NextResponse.json({ error: 'supportingDocUrl must be a valid https URL' }, { status: 400 })
    }

    const sourceOfFunds = await prisma.kycSourceOfFunds.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        sourceType,
        annualIncome: new Prisma.Decimal(incomeNum.toString()),
        currency,
        occupation: occupation.trim(),
        companyName: companyName?.trim() ?? null,
        supportingDocUrl: supportingDocUrl ?? null,
      },
      update: {
        sourceType,
        annualIncome: new Prisma.Decimal(incomeNum.toString()),
        currency,
        occupation: occupation.trim(),
        companyName: companyName?.trim() ?? null,
        supportingDocUrl: supportingDocUrl ?? null,
      },
    })

    return NextResponse.json({ sourceOfFunds }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'KYC source-of-funds error')
    return NextResponse.json({ error: 'Failed to submit source-of-funds declaration' }, { status: 500 })
  }
}
