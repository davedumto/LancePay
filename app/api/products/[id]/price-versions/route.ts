import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { z } from 'zod'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

const createPriceVersionSchema = z.object({
  price: z.number().nonnegative(),
  effectiveDate: z.string().datetime().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 })
    }

    const product = await prisma.product.findFirst({
      where: { id, userId: auth.user.id },
    })
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const priceVersions = await prisma.productPriceVersion.findMany({
      where: { productId: id },
      orderBy: { effectiveDate: 'desc' },
    })

    return NextResponse.json({ priceVersions }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'Failed to list price versions')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Product ID is required' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createPriceVersionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const product = await prisma.product.findFirst({
      where: { id, userId: auth.user.id },
    })
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const { price } = parsed.data
    const effectiveDate = parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : new Date()
    const now = new Date()
    // A version scheduled in the future stays inactive until its effective date
    // arrives; a version effective now (or in the past) becomes active on write.
    const isActive = effectiveDate.getTime() <= now.getTime()

    const priceVersion = await prisma.$transaction(async (tx) => {
      // When the new version is active now, supersede any currently-active
      // version. Prior versions are never deleted and their price/effectiveDate
      // are never mutated, so past invoices keep resolving to the price that was
      // active on their issue date; only the "currently active" flag moves.
      if (isActive) {
        await tx.productPriceVersion.updateMany({
          where: { productId: id, isActive: true },
          data: { isActive: false },
        })
      }

      const created = await tx.productPriceVersion.create({
        data: {
          productId: id,
          priceUsdc: price,
          effectiveDate,
          isActive,
        },
      })

      // Keep the mutable priceUsdc mirror in sync only when the active price
      // actually changes now.
      if (isActive) {
        await tx.product.update({
          where: { id },
          data: { priceUsdc: price },
        })
      }

      return created
    })

    return NextResponse.json(priceVersion, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Failed to create price version')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
