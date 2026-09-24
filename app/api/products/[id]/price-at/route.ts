import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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

    // Default to the current date when no date parameter is supplied.
    const dateParam = request.nextUrl.searchParams.get('date')
    const at = dateParam ? new Date(dateParam) : new Date()
    if (Number.isNaN(at.getTime())) {
      return NextResponse.json({ error: 'Invalid date parameter' }, { status: 400 })
    }

    const product = await prisma.product.findFirst({
      where: { id, userId: auth.user.id },
    })
    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Pick the version whose effective date is the latest one on or before the
    // requested date.
    const priceVersion = await prisma.productPriceVersion.findFirst({
      where: { productId: id, effectiveDate: { lte: at } },
      orderBy: { effectiveDate: 'desc' },
    })

    if (!priceVersion) {
      return NextResponse.json(
        { error: 'No price version effective on the requested date' },
        { status: 404 }
      )
    }

    return NextResponse.json(
      { productId: id, date: at.toISOString(), priceVersion },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Failed to resolve price at date')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
