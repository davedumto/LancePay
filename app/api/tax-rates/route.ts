import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createTaxRateSchema } from '@/lib/validations'
import { rangesOverlap } from '@/lib/tax-rates'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

function serializeRate(rate: {
  id: string
  name: string
  description: string | null
  jurisdiction: string
  rate: unknown
  effectiveFrom: Date
  effectiveTo: Date | null
  parentRateId: string | null
  isDefault: boolean
  createdAt: Date
}) {
  return {
    id: rate.id,
    name: rate.name,
    description: rate.description,
    jurisdiction: rate.jurisdiction,
    rate: Number(rate.rate),
    effectiveFrom: rate.effectiveFrom.toISOString(),
    effectiveTo: rate.effectiveTo ? rate.effectiveTo.toISOString() : null,
    parentRateId: rate.parentRateId,
    isDefault: rate.isDefault,
    createdAt: rate.createdAt.toISOString(),
  }
}

export async function GET(request: NextRequest) {
  const resolved = await resolveUser(request)
  if ('error' in resolved) return resolved.error
  const { user } = resolved

  const jurisdiction = new URL(request.url).searchParams.get('jurisdiction')

  const rates = await prisma.taxRate.findMany({
    where: {
      userId: user.id,
      ...(jurisdiction ? { jurisdiction } : {}),
    },
    orderBy: [{ jurisdiction: 'asc' }, { effectiveFrom: 'desc' }],
  })

  return NextResponse.json({ taxRates: rates.map(serializeRate) })
}

export async function POST(request: NextRequest) {
  const resolved = await resolveUser(request)
  if ('error' in resolved) return resolved.error
  const { user } = resolved

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = createTaxRateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const {
    name,
    description,
    jurisdiction,
    rate,
    effectiveFrom,
    effectiveTo,
    parentRateId,
    isDefault,
  } = parsed.data

  const newFrom = new Date(effectiveFrom)
  const newTo = effectiveTo ? new Date(effectiveTo) : null

  // Compound tax: the parent must exist, belong to the caller, and take effect
  // no later than this rate (a rate is applied *after* the rate it references).
  if (parentRateId) {
    const parent = await prisma.taxRate.findFirst({
      where: { id: parentRateId, userId: user.id },
    })
    if (!parent) {
      return NextResponse.json(
        { error: 'Parent tax rate not found' },
        { status: 400 },
      )
    }
    if (parent.effectiveFrom.getTime() > newFrom.getTime()) {
      return NextResponse.json(
        { error: 'Parent tax rate must take effect on or before this rate' },
        { status: 400 },
      )
    }
  }

  // Reject overlapping effective date ranges for the same jurisdiction so a
  // date can never resolve to more than one rate.
  const siblings = await prisma.taxRate.findMany({
    where: { userId: user.id, jurisdiction },
    select: { effectiveFrom: true, effectiveTo: true },
  })
  const overlaps = siblings.some((sibling) =>
    rangesOverlap(newFrom, newTo, sibling.effectiveFrom, sibling.effectiveTo),
  )
  if (overlaps) {
    return NextResponse.json(
      {
        error: 'An effective date range already exists for this jurisdiction and overlaps the requested range',
      },
      { status: 409 },
    )
  }

  const created = await prisma.taxRate.create({
    data: {
      userId: user.id,
      name,
      description: description ?? null,
      jurisdiction,
      rate,
      effectiveFrom: newFrom,
      effectiveTo: newTo,
      parentRateId: parentRateId ?? null,
      isDefault: isDefault ?? false,
    },
  })

  return NextResponse.json(serializeRate(created), { status: 201 })
}
