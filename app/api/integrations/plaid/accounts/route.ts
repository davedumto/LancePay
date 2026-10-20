import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const plaidAccounts = await prisma.plaidAccount.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    })

    const accounts = plaidAccounts.map((account) => ({
      id: account.id,
      institutionName: account.institutionName,
      accountName: account.accountName,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      status: account.status,
      lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    }))

    return NextResponse.json({ accounts })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/integrations/plaid/accounts error')
    return NextResponse.json(
      { error: 'Failed to list connected Plaid accounts' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      plaidItemId,
      plaidAccountId,
      institutionName,
      accountName,
      mask,
      type,
      subtype,
    } = (body ?? {}) as {
      plaidItemId?: string
      plaidAccountId?: string
      institutionName?: string
      accountName?: string
      mask?: string
      type?: string
      subtype?: string
    }

    if (!plaidItemId || typeof plaidItemId !== 'string' || !plaidItemId.trim()) {
      return NextResponse.json({ error: 'plaidItemId is required' }, { status: 400 })
    }
    if (!plaidAccountId || typeof plaidAccountId !== 'string' || !plaidAccountId.trim()) {
      return NextResponse.json({ error: 'plaidAccountId is required' }, { status: 400 })
    }
    if (!institutionName || typeof institutionName !== 'string' || !institutionName.trim()) {
      return NextResponse.json({ error: 'institutionName is required' }, { status: 400 })
    }
    if (!accountName || typeof accountName !== 'string' || !accountName.trim()) {
      return NextResponse.json({ error: 'accountName is required' }, { status: 400 })
    }
    if (!type || typeof type !== 'string' || !type.trim()) {
      return NextResponse.json({ error: 'type is required' }, { status: 400 })
    }

    // Check unique plaidAccountId
    const existing = await prisma.plaidAccount.findUnique({
      where: { plaidAccountId: plaidAccountId.trim() },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'Account already linked' },
        { status: 409 },
      )
    }

    const account = await prisma.plaidAccount.create({
      data: {
        userId: user.id,
        plaidItemId: plaidItemId.trim(),
        plaidAccountId: plaidAccountId.trim(),
        institutionName: institutionName.trim(),
        accountName: accountName.trim(),
        mask: mask?.trim() || null,
        type: type.trim(),
        subtype: subtype?.trim() || null,
        status: 'active',
        lastSyncedAt: null,
      },
    })

    return NextResponse.json({ account }, { status: 201 })
  } catch (error) {
    if ((error as any)?.code === 'P2002') {
      return NextResponse.json({ error: 'Account already linked' }, { status: 409 })
    }
    logger.error({ err: error }, 'POST /api/integrations/plaid/accounts error')
    return NextResponse.json({ error: 'Failed to link Plaid account' }, { status: 500 })
  }
}
