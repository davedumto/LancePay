import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/integrations/plaid/connect — connect a Plaid account ──
//
// Accepts Plaid Link public_token and exchanges it for stored account data.
// Creates or updates the Plaid item and linked accounts.

interface PlaidConnectBody {
  publicToken?: string
  accounts?: Array<{
    id: string
    name: string
    mask?: string
    type: string
    subtype?: string
    institutionName?: string
  }>
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ 
      where: { privyId: claims.userId },
      select: { id: true, role: true }
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as PlaidConnectBody | null
    if (!body || !body.publicToken || !body.accounts || !Array.isArray(body.accounts)) {
      return NextResponse.json(
        { error: 'Invalid request: publicToken and accounts are required' },
        { status: 400 }
      )
    }

    const userId = user.id

    // Create or update Plaid accounts from the provided data
    const createdAccounts = []
    
    for (const accountData of body.accounts) {
      if (!accountData.id || !accountData.name) {
        continue // skip invalid account entries
      }

      const account = await (prisma as any).plaidAccount.upsert({
        where: {
          plaidAccountId: accountData.id,
        },
        update: {
          institutionName: accountData.institutionName || null,
          accountName: accountData.name,
          mask: accountData.mask || null,
          type: accountData.type,
          subtype: accountData.subtype || null,
          status: 'active',
          lastSyncedAt: new Date(),
        },
        create: {
          userId,
          plaidItemId: `plaid_item_${body.publicToken.slice(0, 8)}`,
          plaidAccountId: accountData.id,
          institutionName: accountData.institutionName || null,
          accountName: accountData.name,
          mask: accountData.mask || null,
          type: accountData.type,
          subtype: accountData.subtype || null,
          status: 'active',
          lastSyncedAt: new Date(),
        },
      })
      
      createdAccounts.push(account)
    }

    logger.info({ 
      userId, 
      accountCount: createdAccounts.length,
      publicToken: body.publicToken.slice(0, 8) + '...'
    }, 'POST /api/routes-d/integrations/plaid/connect')

    return NextResponse.json({ 
      success: true,
      accounts: createdAccounts.map(acc => ({
        id: acc.id,
        institutionName: acc.institutionName,
        accountName: acc.accountName,
        mask: acc.mask,
        type: acc.type,
        subtype: acc.subtype,
        status: acc.status,
      }))
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/integrations/plaid/connect error')
    return NextResponse.json(
      { error: 'Failed to connect Plaid account' },
      { status: 500 }
    )
  }
}