import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_PLAID_TYPES = new Set([
  'depository',
  'credit',
  'loan',
  'investment',
  'brokerage',
  'other',
])

const ALLOWED_PLAID_SUBTYPES = new Set([
  'checking',
  'savings',
  'hsa',
  'cd',
  'money market',
  'money_market',
  'paypal',
  'prepaid',
  'cash management',
  'cash_management',
  'ebt',
  'credit card',
  'credit_card',
  'auto',
  'business',
  'commercial',
  'construction',
  'consumer',
  'home equity',
  'home_equity',
  'loan',
  'mortgage',
  'overdraft',
  'line of credit',
  'line_of_credit',
  'student',
  '401a',
  '401k',
  '403B',
  '457b',
  '529',
  'brokerage',
  'cash isa',
  'crypto exchange',
  'education savings account',
  'ira',
  'isa',
  'keogh',
  'lif',
  'life insurance',
  ' lira',
  'lrif',
  'lrsp',
  'mutual fund',
  'non-custodial wallet',
  'non-taxable brokerage account',
  'other',
  'other annuity',
  'other insurance',
  'pension',
  'prif',
  'profit sharing plan',
  'qshr',
  'rdsp',
  'resp',
  'retirement',
  'rlif',
  'roth',
  'roth 401k',
  'rrif',
  'rrsp',
  'sarsep',
  'sep ira',
  'simple ira',
  'sipp',
  'stock plan',
  'tfsa',
  'trust',
  'ugma',
  'utma',
  'variable annuity',
])

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

async function resolveAuthenticatedUserId(req: NextRequest): Promise<string | null> {
  const token = extractToken(req)
  if (!token) return null
  const claims = await verifyAuthToken(token)
  if (!claims) return null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (dbUser?.id) return dbUser.id
  }

  return claims.userId
}

/**
 * GET /api/integrations/plaid/accounts
 * Lists all Plaid-linked accounts owned by the authenticated user.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await resolveAuthenticatedUserId(req)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const plaidAccounts = await prisma.plaidAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      accounts: plaidAccounts,
      data: plaidAccounts,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/integrations/plaid/accounts error')
    return NextResponse.json(
      { error: 'Failed to list Plaid accounts' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/integrations/plaid/accounts
 * Links a Plaid account after token exchange. Enforces unique plaidAccountId,
 * validates Plaid type/subtype without silent coercion, defaults status to
 * 'active', and leaves lastSyncedAt as null until an actual sync completes.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await resolveAuthenticatedUserId(req)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const plaidItemId =
      typeof body.plaidItemId === 'string' ? body.plaidItemId.trim() : ''
    const plaidAccountId =
      typeof body.plaidAccountId === 'string' ? body.plaidAccountId.trim() : ''
    const institutionName =
      typeof body.institutionName === 'string'
        ? body.institutionName.trim()
        : ''
    const accountName =
      typeof body.accountName === 'string' ? body.accountName.trim() : ''
    const type = typeof body.type === 'string' ? body.type.trim() : ''

    if (!plaidItemId) {
      return NextResponse.json(
        { error: 'plaidItemId is required' },
        { status: 400 },
      )
    }

    if (!plaidAccountId) {
      return NextResponse.json(
        { error: 'plaidAccountId is required' },
        { status: 400 },
      )
    }

    if (!institutionName) {
      return NextResponse.json(
        { error: 'institutionName is required' },
        { status: 400 },
      )
    }

    if (!accountName) {
      return NextResponse.json(
        { error: 'accountName is required' },
        { status: 400 },
      )
    }

    if (!type || !ALLOWED_PLAID_TYPES.has(type)) {
      return NextResponse.json(
        {
          error: `Invalid Plaid account type "${type}". Must be one of: ${Array.from(ALLOWED_PLAID_TYPES).join(', ')}`,
        },
        { status: 400 },
      )
    }

    let subtype: string | null = null
    if (body.subtype !== undefined && body.subtype !== null) {
      if (typeof body.subtype !== 'string' || !body.subtype.trim()) {
        return NextResponse.json(
          { error: 'subtype must be a non-empty string when provided' },
          { status: 400 },
        )
      }
      const rawSubtype = body.subtype.trim()
      if (!ALLOWED_PLAID_SUBTYPES.has(rawSubtype.toLowerCase()) && !ALLOWED_PLAID_SUBTYPES.has(rawSubtype)) {
        return NextResponse.json(
          { error: `Unrecognized Plaid account subtype "${rawSubtype}"` },
          { status: 400 },
        )
      }
      subtype = rawSubtype
    }

    let mask: string | null = null
    if (body.mask !== undefined && body.mask !== null) {
      if (
        typeof body.mask !== 'string' ||
        !/^[A-Za-z0-9]{2,4}$/.test(body.mask.trim())
      ) {
        return NextResponse.json(
          { error: 'mask must be a 2 to 4 character alphanumeric string' },
          { status: 400 },
        )
      }
      mask = body.mask.trim()
    }

    // Enforce unique plaidAccountId constraint with a clean 409 response
    const existing = await prisma.plaidAccount.findUnique({
      where: { plaidAccountId },
    })

    if (existing) {
      return NextResponse.json(
        {
          error: 'Plaid account is already linked',
          code: 'PLAID_ACCOUNT_ALREADY_LINKED',
          plaidAccountId,
        },
        { status: 409 },
      )
    }

    const account = await prisma.plaidAccount.create({
      data: {
        userId,
        plaidItemId,
        plaidAccountId,
        institutionName,
        accountName,
        mask,
        type,
        subtype,
        status: 'active',
        lastSyncedAt: null,
      },
    })

    logger?.info?.(
      { userId, plaidAccountId, institutionName, type, subtype },
      'POST /api/integrations/plaid/accounts linked account',
    )

    return NextResponse.json(
      { account, data: account },
      { status: 201 },
    )
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      return NextResponse.json(
        {
          error: 'Plaid account is already linked',
          code: 'PLAID_ACCOUNT_ALREADY_LINKED',
        },
        { status: 409 },
      )
    }

    logger?.error?.({ err }, 'POST /api/integrations/plaid/accounts error')
    return NextResponse.json(
      { error: 'Failed to link Plaid account' },
      { status: 500 },
    )
  }
}
