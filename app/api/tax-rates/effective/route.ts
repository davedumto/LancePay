import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { combineRates, resolveRateChain, type ChainNode } from '@/lib/tax-rates'

/**
 * GET /api/tax-rates/effective?jurisdiction=US-CA&date=2026-01-15
 *
 * Resolves which tax rate was in force for a jurisdiction on a given date
 * (defaulting to now) and returns its effective combined percentage, resolving
 * any compound parent chain into a single figure.
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

  const searchParams = new URL(request.url).searchParams
  const jurisdiction = searchParams.get('jurisdiction')
  if (!jurisdiction) {
    return NextResponse.json(
      { error: 'jurisdiction query parameter is required' },
      { status: 400 },
    )
  }

  const dateParam = searchParams.get('date')
  const asOf = dateParam ? new Date(dateParam) : new Date()
  if (isNaN(asOf.getTime())) {
    return NextResponse.json(
      { error: 'Invalid date query parameter' },
      { status: 400 },
    )
  }

  // Select the rate whose effective window contains the requested date, not
  // merely the most recent rate. Half-open window: effectiveFrom <= date < effectiveTo.
  const rate = await prisma.taxRate.findFirst({
    where: {
      userId: user.id,
      jurisdiction,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  if (!rate) {
    return NextResponse.json(
      {
        error: `No tax rate covers jurisdiction "${jurisdiction}" on ${asOf.toISOString().slice(0, 10)}`,
      },
      { status: 404 },
    )
  }

  // Load the full compound chain by walking parent references.
  const nodesById = new Map<string, ChainNode>()
  let cursorId: string | null = rate.id
  const chainRates = [rate]
  nodesById.set(rate.id, {
    id: rate.id,
    name: rate.name,
    rate: Number(rate.rate),
    parentRateId: rate.parentRateId,
  })
  cursorId = rate.parentRateId
  while (cursorId && !nodesById.has(cursorId)) {
    const parent = await prisma.taxRate.findFirst({
      where: { id: cursorId, userId: user.id },
    })
    if (!parent) break
    chainRates.push(parent)
    nodesById.set(parent.id, {
      id: parent.id,
      name: parent.name,
      rate: Number(parent.rate),
      parentRateId: parent.parentRateId,
    })
    cursorId = parent.parentRateId
  }

  const components = resolveRateChain(rate.id, nodesById)
  const effectiveRate = combineRates(components)

  return NextResponse.json({
    id: rate.id,
    name: rate.name,
    jurisdiction: rate.jurisdiction,
    date: asOf.toISOString(),
    effectiveFrom: rate.effectiveFrom.toISOString(),
    effectiveTo: rate.effectiveTo ? rate.effectiveTo.toISOString() : null,
    rate: Number(rate.rate),
    isCompound: components.length > 1,
    effectiveRate,
    effectivePercentage: Number((effectiveRate * 100).toFixed(4)),
    components,
  })
}
