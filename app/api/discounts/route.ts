import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DISCOUNT_TYPES = ['percent', 'fixed']
const SELECT_FIELDS = {
  id: true,
  code: true,
  type: true,
  value: true,
  active: true,
  maxRedemptions: true,
  redemptions: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
}

/**
 * GET /api/discounts
 * List all discount codes for the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const discounts = await prisma.discount.findMany({
      where: { userId: user.id },
      select: SELECT_FIELDS,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      discounts: discounts.map((discount) => ({
        ...discount,
        value: Number(discount.value),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/discounts error')
    return NextResponse.json({ error: 'Failed to fetch discounts' }, { status: 500 })
  }
}

/**
 * POST /api/discounts
 * Create a new discount code. Enforces unique userId + code constraint.
 * Validates type and value. Defaults active to true and redemptions to 0.
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: any
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { code, type = 'percent', value, maxRedemptions, expiresAt, active = true } = body

    // Validate code
    if (!code || typeof code !== 'string' || !code.trim()) {
      return NextResponse.json({ error: 'code is required and must be a non-empty string' }, { status: 400 })
    }

    // Validate type
    if (!type || !DISCOUNT_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `type must be one of: ${DISCOUNT_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    // Validate value
    if (value === undefined || value === null) {
      return NextResponse.json({ error: 'value is required' }, { status: 400 })
    }

    const numValue = Number(value)
    if (Number.isNaN(numValue) || numValue < 0) {
      return NextResponse.json({ error: 'value must be a non-negative number' }, { status: 400 })
    }

    // Type-specific validation
    if (type === 'percent') {
      if (numValue > 100) {
        return NextResponse.json(
          { error: 'percent discount value must be between 0 and 100' },
          { status: 400 },
        )
      }
    } else if (type === 'fixed') {
      // Fixed discounts can be any non-negative number
      if (!Number.isFinite(numValue)) {
        return NextResponse.json({ error: 'fixed discount value must be a valid number' }, { status: 400 })
      }
    }

    // Validate maxRedemptions if provided
    if (maxRedemptions !== undefined && maxRedemptions !== null) {
      const numMax = Number(maxRedemptions)
      if (!Number.isInteger(numMax) || numMax < 1) {
        return NextResponse.json(
          { error: 'maxRedemptions must be a positive integer' },
          { status: 400 },
        )
      }
    }

    // Validate expiresAt if provided
    if (expiresAt !== undefined && expiresAt !== null) {
      const expDate = new Date(expiresAt)
      if (Number.isNaN(expDate.getTime())) {
        return NextResponse.json(
          { error: 'expiresAt must be a valid ISO date string' },
          { status: 400 },
        )
      }
    }

    // Validate active
    if (typeof active !== 'boolean') {
      return NextResponse.json({ error: 'active must be a boolean' }, { status: 400 })
    }

    // Create discount with unique constraint handling
    try {
      const discount = await prisma.discount.create({
        data: {
          userId: user.id,
          code: code.trim(),
          type,
          value: numValue,
          active,
          maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          // redemptions defaults to 0 via schema default
        },
        select: SELECT_FIELDS,
      })

      return NextResponse.json(
        {
          discount: {
            ...discount,
            value: Number(discount.value),
          },
        },
        { status: 201 },
      )
    } catch (error: any) {
      // Check for unique constraint violation on (userId, code)
      if (error.code === 'P2002' && error.meta?.target?.includes('code')) {
        return NextResponse.json(
          { error: 'A discount code with this code already exists for this user' },
          { status: 409 },
        )
      }
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/discounts error')
    return NextResponse.json({ error: 'Failed to create discount' }, { status: 500 })
  }
}
