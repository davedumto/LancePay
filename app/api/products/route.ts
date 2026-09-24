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

const createProductSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(5000).optional(),
  price: z.number().nonnegative(),
  unit: z.string().trim().min(1).max(50).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const products = await prisma.product.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        priceVersions: {
          where: { isActive: true },
          orderBy: { effectiveDate: 'desc' },
          take: 1,
        },
      },
    })

    const withActivePrice = products.map((product) => {
      const { priceVersions, ...rest } = product
      return { ...rest, activePriceVersion: priceVersions[0] ?? null }
    })

    return NextResponse.json({ products: withActivePrice }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'Failed to list products')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = createProductSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { name, description, price, unit } = parsed.data

    // Product name must be unique per user.
    const existing = await prisma.product.findFirst({
      where: { userId: auth.user.id, name },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A product with this name already exists' },
        { status: 409 }
      )
    }

    // Create the product together with its first (active) price version so the
    // price is stored as a versioned entry rather than a mutable scalar. The
    // mutable priceUsdc column is kept in sync with the active version for
    // backward compatibility with existing readers.
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          userId: auth.user.id,
          name,
          description: description ?? null,
          priceUsdc: price,
          unit: unit ?? 'item',
        },
      })

      const priceVersion = await tx.productPriceVersion.create({
        data: {
          productId: created.id,
          priceUsdc: price,
          effectiveDate: new Date(),
          isActive: true,
        },
      })

      return { ...created, activePriceVersion: priceVersion }
    })

    return NextResponse.json(product, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Failed to create product')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
