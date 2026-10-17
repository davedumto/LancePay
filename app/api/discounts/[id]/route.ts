import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DISCOUNT_SELECT = {
  id: true,
  userId: true,
  code: true,
  type: true,
  value: true,
  active: true,
  maxRedemptions: true,
  redemptions: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const

function serializeDiscount(discount: any) {
  const { userId: _userId, ...rest } = discount
  return {
    ...rest,
    value: Number(discount.value),
  }
}

async function resolveDiscountAndOwner(request: NextRequest, id: string) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { response: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  const discount = await prisma.discount.findUnique({
    where: { id },
    select: DISCOUNT_SELECT,
  })

  if (!discount) {
    return { response: NextResponse.json({ error: 'Discount not found' }, { status: 404 }) }
  }

  if (discount.userId !== user.id) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  return { user, discount }
}

/**
 * GET /api/discounts/[id]
 * Fetch a single discount code owned by the authenticated user.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const { id } = await Promise.resolve(params)
    const resolved = await resolveDiscountAndOwner(request, id)
    if ('response' in resolved) return resolved.response

    return NextResponse.json({
      discount: serializeDiscount(resolved.discount),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/discounts/[id] error')
    return NextResponse.json({ error: 'Failed to fetch discount' }, { status: 500 })
  }
}

/**
 * DELETE /api/discounts/[id]
 * Soft-deactivate a discount code owned by the authenticated user by setting
 * `active: false` (preserving historical DiscountRedemption rows).
 * Rejects deactivating an already-inactive discount with 409 Conflict.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const { id } = await Promise.resolve(params)
    const resolved = await resolveDiscountAndOwner(request, id)
    if ('response' in resolved) return resolved.response

    const { discount } = resolved

    if (!discount.active) {
      return NextResponse.json(
        {
          error: 'Discount code is already inactive',
          code: 'DISCOUNT_ALREADY_INACTIVE',
        },
        { status: 409 },
      )
    }

    const updated = await prisma.discount.update({
      where: { id: discount.id },
      data: { active: false },
      select: DISCOUNT_SELECT,
    })

    return NextResponse.json(
      {
        discount: serializeDiscount(updated),
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/discounts/[id] error')
    return NextResponse.json({ error: 'Failed to deactivate discount' }, { status: 500 })
  }
}
