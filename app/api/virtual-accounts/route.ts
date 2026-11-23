import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_BANK_NAME_LENGTH = 100
const MAX_ACCOUNT_NUMBER_LENGTH = 20
const MAX_ACCOUNT_NAME_LENGTH = 255
const MAX_PROVIDER_LENGTH = 50
const MAX_PROVIDER_REF_LENGTH = 255
const ACCOUNT_NUMBER_PATTERN = /^[A-Za-z0-9-]+$/

// providerRef is stored for reconciliation but is an internal provider
// identifier, so it is not returned to clients.
const virtualAccountSelect = {
  id: true,
  bankName: true,
  accountNumber: true,
  accountName: true,
  provider: true,
  status: true,
  createdAt: true,
} as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

function uniqueConstraintTarget(error: unknown): string[] | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') {
    return null
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (Array.isArray(target)) return target.map(String)
  if (typeof target === 'string') return [target]
  return []
}

function readRequiredText(payload: Record<string, unknown>, field: string, max: number) {
  const raw = payload[field]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { error: `${field} is required` }
  if (value.length > max) return { error: `${field} must be at most ${max} characters` }
  return { value }
}

/**
 * GET /api/virtual-accounts
 * Returns the caller's virtual account, or 404 if none has been provisioned.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const virtualAccount = await prisma.virtualAccount.findUnique({
      where: { userId: user.id },
      select: virtualAccountSelect,
    })

    if (!virtualAccount) {
      return NextResponse.json({ error: 'Virtual account not found' }, { status: 404 })
    }

    return NextResponse.json({ virtualAccount })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/virtual-accounts error')
    return NextResponse.json({ error: 'Failed to fetch virtual account' }, { status: 500 })
  }
}

/**
 * POST /api/virtual-accounts
 * Provisions the caller's single virtual deposit account.
 *
 * Idempotent per user: if one already exists it is returned (200) instead of
 * an error. A new account is created with status `active` (201). An account
 * number already used by another user is a 409.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const existing = await prisma.virtualAccount.findUnique({
      where: { userId: user.id },
      select: virtualAccountSelect,
    })
    if (existing) {
      return NextResponse.json({ virtualAccount: existing, created: false })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }
    const payload = body as Record<string, unknown>

    const bankName = readRequiredText(payload, 'bankName', MAX_BANK_NAME_LENGTH)
    if ('error' in bankName) return NextResponse.json({ error: bankName.error }, { status: 400 })

    const accountNumber = readRequiredText(payload, 'accountNumber', MAX_ACCOUNT_NUMBER_LENGTH)
    if ('error' in accountNumber) return NextResponse.json({ error: accountNumber.error }, { status: 400 })
    if (!ACCOUNT_NUMBER_PATTERN.test(accountNumber.value)) {
      return NextResponse.json(
        { error: 'accountNumber may only contain letters, digits and hyphens' },
        { status: 400 },
      )
    }

    const accountName = readRequiredText(payload, 'accountName', MAX_ACCOUNT_NAME_LENGTH)
    if ('error' in accountName) return NextResponse.json({ error: accountName.error }, { status: 400 })

    const provider = readRequiredText(payload, 'provider', MAX_PROVIDER_LENGTH)
    if ('error' in provider) return NextResponse.json({ error: provider.error }, { status: 400 })

    let providerRef: string | null = null
    if (payload.providerRef !== undefined && payload.providerRef !== null) {
      if (typeof payload.providerRef !== 'string') {
        return NextResponse.json({ error: 'providerRef must be a string' }, { status: 400 })
      }
      providerRef = payload.providerRef.trim() || null
      if (providerRef && providerRef.length > MAX_PROVIDER_REF_LENGTH) {
        return NextResponse.json(
          { error: `providerRef must be at most ${MAX_PROVIDER_REF_LENGTH} characters` },
          { status: 400 },
        )
      }
    }

    const conflict = () =>
      NextResponse.json({ error: 'This account number is already in use' }, { status: 409 })

    // Check first so the common case is a clean conflict, not a database error.
    const taken = await prisma.virtualAccount.findUnique({
      where: { accountNumber: accountNumber.value },
      select: { id: true },
    })
    if (taken) return conflict()

    try {
      const virtualAccount = await prisma.virtualAccount.create({
        data: {
          userId: user.id,
          bankName: bankName.value,
          accountNumber: accountNumber.value,
          accountName: accountName.value,
          provider: provider.value,
          providerRef,
          status: 'active',
        },
        select: virtualAccountSelect,
      })
      return NextResponse.json({ virtualAccount, created: true }, { status: 201 })
    } catch (error) {
      const target = uniqueConstraintTarget(error)
      if (target === null) throw error

      // Lost a race: another request created this user's account in between.
      if (target.some((t) => t.includes('userId'))) {
        const raced = await prisma.virtualAccount.findUnique({
          where: { userId: user.id },
          select: virtualAccountSelect,
        })
        if (raced) return NextResponse.json({ virtualAccount: raced, created: false })
      }
      return conflict()
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/virtual-accounts error')
    return NextResponse.json({ error: 'Failed to provision virtual account' }, { status: 500 })
  }
}
