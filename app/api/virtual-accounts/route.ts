import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, randomInt } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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

function generateCandidateAccountNumber(): string {
  return String(randomInt(1000000000, 9999999999))
}

function generateProviderRef(provider: string): string {
  return `${provider.toLowerCase()}_va_${randomBytes(8).toString('hex')}`
}

function serializeVirtualAccount(record: Record<string, any>) {
  return {
    id: record.id,
    userId: record.userId,
    bankName: record.bankName,
    accountNumber: record.accountNumber,
    accountName: record.accountName,
    provider: record.provider,
    providerRef: record.providerRef ?? null,
    status: record.status ?? 'active',
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
  }
}

/**
 * GET /api/virtual-accounts
 * Returns the authenticated user's provisioned `VirtualAccount`, or `404` if none exists yet.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const existing =
      typeof prisma.virtualAccount?.findUnique === 'function'
        ? await prisma.virtualAccount.findUnique({
            where: { userId: user.id },
          })
        : await prisma.virtualAccount?.findFirst?.({
            where: { userId: user.id },
          })

    if (!existing) {
      return NextResponse.json(
        { error: 'Virtual account not found' },
        { status: 404 },
      )
    }

    return NextResponse.json({
      virtualAccount: serializeVirtualAccount(existing),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/virtual-accounts error')
    return NextResponse.json(
      { error: 'Failed to fetch virtual account' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/virtual-accounts
 * Provisions a dedicated `VirtualAccount` for the authenticated user:
 * - Enforces the unique `userId` constraint by returning the existing account (`200`) instead
 *   of erroring if one is already provisioned.
 * - Validates `accountNumber` uniqueness before creating/returning it, surfacing a clean `409`
 *   conflict rather than a raw database error.
 * - Defaults `status` to `'active'` and stores `providerRef` for later reconciliation.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    // 1. Check if the user already has a provisioned virtual account
    const existingForUser =
      typeof prisma.virtualAccount?.findUnique === 'function'
        ? await prisma.virtualAccount.findUnique({
            where: { userId: user.id },
          })
        : await prisma.virtualAccount?.findFirst?.({
            where: { userId: user.id },
          })

    if (existingForUser && existingForUser.userId === user.id) {
      return NextResponse.json(
        {
          reusedExisting: true,
          virtualAccount: serializeVirtualAccount(existingForUser),
        },
        { status: 200 },
      )
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >

    const provider =
      typeof body.provider === 'string' && body.provider.trim()
        ? body.provider.trim()
        : 'paystack'
    const bankName =
      typeof body.bankName === 'string' && body.bankName.trim()
        ? body.bankName.trim()
        : 'Wema Bank'
    const accountName =
      typeof body.accountName === 'string' && body.accountName.trim()
        ? body.accountName.trim()
        : user.name || user.email || `LancePay - ${user.id}`
    const accountNumber =
      typeof body.accountNumber === 'string' && body.accountNumber.trim()
        ? body.accountNumber.trim()
        : generateCandidateAccountNumber()
    const providerRef =
      typeof body.providerRef === 'string' && body.providerRef.trim()
        ? body.providerRef.trim()
        : generateProviderRef(provider)

    if (!/^\d{6,20}$/.test(accountNumber)) {
      return NextResponse.json(
        {
          error: 'accountNumber must be a 6 to 20 digit numeric string',
          code: 'INVALID_ACCOUNT_NUMBER',
        },
        { status: 400 },
      )
    }

    // 2. Validate accountNumber uniqueness before creating
    let conflictingAccount: Record<string, any> | null = null
    if (typeof prisma.virtualAccount?.findUnique === 'function') {
      conflictingAccount = await prisma.virtualAccount.findUnique({
        where: { accountNumber },
      })
    } else if (typeof prisma.virtualAccount?.findFirst === 'function') {
      conflictingAccount = await prisma.virtualAccount.findFirst({
        where: { accountNumber },
      })
    }

    if (conflictingAccount && conflictingAccount.userId !== user.id) {
      return NextResponse.json(
        {
          error: 'Virtual account number is already assigned to another account',
          code: 'ACCOUNT_NUMBER_CONFLICT',
        },
        { status: 409 },
      )
    }

    let created: Record<string, any>
    try {
      created = await prisma.virtualAccount.create({
        data: {
          userId: user.id,
          bankName,
          accountNumber,
          accountName,
          provider,
          providerRef,
          status: 'active',
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json(
          {
            error: 'Virtual account number conflict',
            code: 'ACCOUNT_NUMBER_CONFLICT',
          },
          { status: 409 },
        )
      }
      throw err
    }

    return NextResponse.json(
      {
        reusedExisting: false,
        virtualAccount: serializeVirtualAccount(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/virtual-accounts error')
    return NextResponse.json(
      { error: 'Failed to provision virtual account' },
      { status: 500 },
    )
  }
}
