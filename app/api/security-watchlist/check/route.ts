import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { isAdminEmail } from '@/lib/authorization'
import { logger } from '@/lib/logger'

type ComplianceActorResult =
  | { user: { id: string; role: string; email: string } }
  | { response: NextResponse }

async function requireComplianceActor(request: NextRequest): Promise<ComplianceActorResult> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = authToken ? await verifyAuthToken(authToken) : null
  if (!claims) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true, email: true },
  })
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (user.role !== 'admin' && user.role !== 'compliance' && !isAdminEmail(user.email)) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

export async function GET(request: NextRequest) {
  try {
    const actor = await requireComplianceActor(request)
    if ('response' in actor) return actor.response

    const value = new URL(request.url).searchParams.get('value')?.trim()
    if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })

    const entry = await prisma.securityWatchlist.findUnique({
      where: { value },
      select: { id: true, type: true, value: true, reason: true, createdAt: true },
    })

    return NextResponse.json({ match: Boolean(entry), entry })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/security-watchlist/check error')
    return NextResponse.json({ error: 'Failed to check security watchlist' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const value = searchParams.get('value')
    let type = searchParams.get('type')

    if (!value) {
      return NextResponse.json({ error: 'Missing value parameter' }, { status: 400 })
    }

    let normalizedValue = value.trim()

    // If type is not provided, try to infer it
    if (!type) {
      if (normalizedValue.includes('@')) {
        type = 'email'
      } else {
        type = 'wallet'
      }
    }

    if (type === 'email') {
      normalizedValue = normalizedValue.toLowerCase()
    } else if (type === 'wallet') {
      // Wallet addresses (Stellar/EVM) could be handled differently. 
      // For EVM, it's often lowercased or checksummed. For Stellar, it's case-sensitive but usually uppercase.
      // We keep it as is, or maybe just trimmed, but if we need a specific rule, we apply it here.
      // Assuming lowercase for simple EVM equivalence or leaving trimmed for Stellar.
      // We will leave it as trimmed for Stellar, or lowercased if it looks like EVM.
      // Actually, if it starts with 0x we can lowercase it.
      if (normalizedValue.startsWith('0x')) {
        normalizedValue = normalizedValue.toLowerCase()
      }
    }

    const entry = await prisma.securityWatchlist.findFirst({
      where: {
        value: normalizedValue,
        ...(type && { type })
      }
    })

    if (entry) {
      return NextResponse.json({
        match: true,
        type: entry.type
      })
    }

    return NextResponse.json({
      match: false
    })
  } catch (error) {
    console.error('GET /api/security-watchlist/check error', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
