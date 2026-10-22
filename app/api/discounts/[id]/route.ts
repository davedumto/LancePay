import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

// GET /api/discounts/[id] — fetch a single discount owned by the authenticated user.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const discount = await prisma.discount.findUnique({ where: { id } })

    if (!discount) {
      return NextResponse.json({ error: 'Discount not found' }, { status: 404 })
    }
    if (discount.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ discount })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/discounts/[id] error')
    return NextResponse.json({ error: 'Failed to fetch discount' }, { status: 500 })
  }
}

// DELETE /api/discounts/[id] — soft-deactivate a discount code owned by the
// authenticated user. Sets active=false rather than hard-deleting so that
// existing DiscountRedemption rows remain valid references.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const discount = await prisma.discount.findUnique({
      where: { id },
      select: { id: true, userId: true, active: true },
    })

    if (!discount) {
      return NextResponse.json({ error: 'Discount not found' }, { status: 404 })
    }
    if (discount.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (!discount.active) {
      return NextResponse.json(
        { error: 'Discount is already inactive', discount },
        { status: 409 },
      )
    }

    const updated = await prisma.discount.update({
      where: { id },
      data: { active: false },
    })

    return NextResponse.json({ discount: updated })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/discounts/[id] error')
    return NextResponse.json({ error: 'Failed to deactivate discount' }, { status: 500 })
  }
}
