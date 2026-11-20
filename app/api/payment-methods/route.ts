import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_TYPES = ['stellar_wallet', 'bank_account']

const stellarWalletRegex = /^G[A-Z0-9]{55}$/
const bankAccountRegex = /^[A-Z0-9]{10,34}$/

function validateValue(type: string, value: string): boolean {
  switch (type) {
    case 'stellar_wallet':
      return stellarWalletRegex.test(value)
    case 'bank_account':
      return bankAccountRegex.test(value)
    default:
      return false
  }
}

const createPaymentMethodSchema = z
  .object({
    type: z.enum(['stellar_wallet', 'bank_account'] as const),
    name: z.string().trim().max(100).optional(),
    value: z.string().trim().min(1, 'Value is required'),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => validateValue(data.type, data.value),
    {
      message: 'Invalid value format for the specified type',
      path: ['value'],
    },
  )

type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

/**
 * GET /api/payment-methods
 * Returns the caller's payment methods
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const paymentMethods = await prisma.paymentMethod.findMany({
      where: { userId: user.id },
      select: { id: true, type: true, name: true, value: true, isDefault: true, createdAt: true, updatedAt: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })

    return NextResponse.json({ paymentMethods })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payment-methods error')
    return NextResponse.json({ error: 'Failed to fetch payment methods' }, { status: 500 })
  }
}

/**
 * POST /api/payment-methods
 * Creates a new payment method for the authenticated user
 * Ensures exactly one default method per user
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = createPaymentMethodSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const paymentMethod = await prisma.$transaction(async (tx) => {
      // Check if this is the user's first payment method
      const existingCount = await tx.paymentMethod.count({
        where: { userId: user.id },
      })

      const isDefault = parsed.data.isDefault ?? existingCount === 0

      // If this method should be default, unset default on all others
      if (isDefault) {
        await tx.paymentMethod.updateMany({
          where: { userId: user.id, isDefault: true },
          data: { isDefault: false },
        })
      }

      // Create the new payment method
      const created = await tx.paymentMethod.create({
        data: {
          userId: user.id,
          type: parsed.data.type,
          name: parsed.data.name || null,
          value: parsed.data.value,
          isDefault,
        },
        select: { id: true, type: true, name: true, value: true, isDefault: true, createdAt: true, updatedAt: true },
      })

      return created
    })

    logger.info({ userId: user.id, paymentMethodId: paymentMethod.id }, 'Payment method created')

    return NextResponse.json({ paymentMethod }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payment-methods error')
    return NextResponse.json({ error: 'Failed to create payment method' }, { status: 500 })
  }
}
