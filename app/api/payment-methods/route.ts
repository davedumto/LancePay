import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_PAYMENT_METHOD_TYPES = [
  'stellar_wallet',
  'bank_account',
  'evm_wallet',
  'crypto_wallet',
] as const

export type PaymentMethodType = (typeof ALLOWED_PAYMENT_METHOD_TYPES)[number]

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/
const BANK_ACCOUNT_STRING_REGEX = /^[A-Za-z0-9\-:\s]{6,64}$/

export function validatePaymentMethodDetails(
  type: PaymentMethodType,
  rawValue: unknown,
): { valid: boolean; normalizedValue: string; error?: string } {
  if (rawValue === undefined || rawValue === null) {
    return {
      valid: false,
      normalizedValue: '',
      error: 'value (or details) is required',
    }
  }

  if (type === 'stellar_wallet') {
    const str =
      typeof rawValue === 'string'
        ? rawValue.trim()
        : typeof rawValue === 'object' &&
            typeof (rawValue as any).address === 'string'
          ? (rawValue as any).address.trim()
          : ''
    if (!STELLAR_PUBLIC_KEY_REGEX.test(str)) {
      return {
        valid: false,
        normalizedValue: '',
        error:
          'stellar_wallet value must be a valid 56-character Stellar public key starting with G',
      }
    }
    return { valid: true, normalizedValue: str }
  }

  if (type === 'evm_wallet' || type === 'crypto_wallet') {
    const str =
      typeof rawValue === 'string'
        ? rawValue.trim()
        : typeof rawValue === 'object' &&
            typeof (rawValue as any).address === 'string'
          ? (rawValue as any).address.trim()
          : ''
    if (
      !EVM_ADDRESS_REGEX.test(str) &&
      !STELLAR_PUBLIC_KEY_REGEX.test(str)
    ) {
      return {
        valid: false,
        normalizedValue: '',
        error: `${type} value must be a valid wallet address (0x... or G...)`,
      }
    }
    return { valid: true, normalizedValue: str }
  }

  if (type === 'bank_account') {
    if (typeof rawValue === 'object' && rawValue !== null) {
      const obj = rawValue as Record<string, unknown>
      const acct =
        typeof obj.accountNumber === 'string' ? obj.accountNumber.trim() : ''
      if (!/^\d{6,34}$/.test(acct)) {
        return {
          valid: false,
          normalizedValue: '',
          error:
            'bank_account details must include a numeric accountNumber (6-34 digits)',
        }
      }
      return { valid: true, normalizedValue: JSON.stringify(obj) }
    }

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim()
      // Reject Stellar or EVM addresses masquerading as bank accounts or overly short/invalid strings
      if (
        STELLAR_PUBLIC_KEY_REGEX.test(trimmed) ||
        EVM_ADDRESS_REGEX.test(trimmed) ||
        !BANK_ACCOUNT_STRING_REGEX.test(trimmed) ||
        !/\d{4,}/.test(trimmed)
      ) {
        return {
          valid: false,
          normalizedValue: '',
          error:
            'bank_account value must be a valid bank account identifier containing digits',
        }
      }
      return { valid: true, normalizedValue: trimmed }
    }
  }

  return {
    valid: false,
    normalizedValue: '',
    error: 'Invalid payment method value for declared type',
  }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializePaymentMethod(method: Record<string, any>) {
  return {
    id: method.id,
    userId: method.userId,
    type: method.type,
    name: method.name ?? null,
    value: method.value,
    isDefault: Boolean(method.isDefault),
    createdAt: method.createdAt
      ? new Date(method.createdAt).toISOString()
      : null,
    updatedAt: method.updatedAt
      ? new Date(method.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/payment-methods
 * Lists payment methods registered by the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const methods = ((await prisma.paymentMethod.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })) ?? []) as Array<Record<string, any>>

    return NextResponse.json({
      paymentMethods: methods.map(serializePaymentMethod),
      total: methods.length,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/payment-methods error')
    return NextResponse.json(
      { error: 'Failed to list payment methods' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/payment-methods
 * Registers a `PaymentMethod` for the authenticated user and enforces that at most one
 * method is marked `isDefault`:
 * - Validates `type` against the allowed set and validates `value` / `details` format matches `type`.
 * - If this is the user's first payment method, defaults `isDefault` to `true` automatically.
 * - When a new method is created with `isDefault: true`, atomically unsets `isDefault` on all
 *   other methods for that user in the same transaction.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawType =
      typeof body.type === 'string' ? body.type.trim().toLowerCase() : ''
    if (
      !(ALLOWED_PAYMENT_METHOD_TYPES as readonly string[]).includes(rawType)
    ) {
      return NextResponse.json(
        {
          error: `type must be one of: ${ALLOWED_PAYMENT_METHOD_TYPES.join(', ')}`,
          code: 'INVALID_PAYMENT_METHOD_TYPE',
        },
        { status: 400 },
      )
    }
    const type = rawType as PaymentMethodType

    const rawValue = body.value !== undefined ? body.value : body.details
    const detailsCheck = validatePaymentMethodDetails(type, rawValue)
    if (!detailsCheck.valid) {
      return NextResponse.json(
        {
          error: detailsCheck.error ?? 'Invalid payment method details',
          code: 'INVALID_PAYMENT_METHOD_DETAILS',
        },
        { status: 400 },
      )
    }

    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : null

    const executeCreate = async (tx: typeof prisma) => {
      let existingCount = 0
      if (typeof tx.paymentMethod?.count === 'function') {
        const c = await tx.paymentMethod.count({
          where: { userId: user.id },
        })
        if (typeof c === 'number') {
          existingCount = c
        }
      } else if (typeof tx.paymentMethod?.findMany === 'function') {
        const existing = await tx.paymentMethod.findMany({
          where: { userId: user.id },
        })
        existingCount = Array.isArray(existing) ? existing.length : 0
      }

      const isFirstMethod = existingCount === 0
      const shouldBeDefault = isFirstMethod ? true : Boolean(body.isDefault)

      if (
        shouldBeDefault &&
        !isFirstMethod &&
        typeof tx.paymentMethod?.updateMany === 'function'
      ) {
        await tx.paymentMethod.updateMany({
          where: { userId: user.id, isDefault: true },
          data: { isDefault: false },
        })
      }

      const created = await tx.paymentMethod.create({
        data: {
          userId: user.id,
          type,
          name,
          value: detailsCheck.normalizedValue,
          isDefault: shouldBeDefault,
        },
      })

      return created
    }

    const createdMethod =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx: any) => executeCreate(tx))
        : await executeCreate(prisma)

    return NextResponse.json(
      {
        paymentMethod: serializePaymentMethod(createdMethod),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/payment-methods error')
    return NextResponse.json(
      { error: 'Failed to register payment method' },
      { status: 500 },
    )
  }
}
