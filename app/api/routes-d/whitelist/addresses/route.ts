import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET  /api/routes-d/whitelist/addresses — list whitelisted withdrawal addresses ──
// ── POST /api/routes-d/whitelist/addresses — add a whitelisted address ──

const VALID_NETWORKS = ['stellar', 'bank'] as const
type Network = typeof VALID_NETWORKS[number]

const MAX_LABEL_LENGTH = 100
// Stellar addresses are 56 chars; bank account numbers are typically ≤ 34 (IBAN).
const MAX_ADDRESS_LENGTH = 70

type WhitelistDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getWhitelistDelegate(): WhitelistDelegate {
  return (prisma as unknown as { whitelistAddress: WhitelistDelegate }).whitelistAddress
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const addresses = await getWhitelistDelegate().findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        address: true,
        network: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ addresses })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/whitelist/addresses error')
    return NextResponse.json({ error: 'Failed to list whitelist addresses' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as
      | { label?: string; address?: string; network?: string }
      | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { label, address, network } = body

    if (typeof label !== 'string' || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }
    const trimmedLabel = label.trim()
    if (trimmedLabel.length > MAX_LABEL_LENGTH) {
      return NextResponse.json({ error: `label must be at most ${MAX_LABEL_LENGTH} characters` }, { status: 400 })
    }

    if (typeof address !== 'string' || !address.trim()) {
      return NextResponse.json({ error: 'address is required' }, { status: 400 })
    }
    const trimmedAddress = address.trim()
    if (trimmedAddress.length > MAX_ADDRESS_LENGTH) {
      return NextResponse.json({ error: `address must be at most ${MAX_ADDRESS_LENGTH} characters` }, { status: 400 })
    }

    const resolvedNetwork: Network =
      typeof network === 'string' && VALID_NETWORKS.includes(network as Network)
        ? (network as Network)
        : 'stellar'

    const entry = await getWhitelistDelegate().create({
      data: {
        userId: user.id,
        label: trimmedLabel,
        address: trimmedAddress,
        network: resolvedNetwork,
      },
      select: {
        id: true,
        label: true,
        address: true,
        network: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ address: entry }, { status: 201 })
  } catch (error) {
    // Unique constraint: address already whitelisted by this user.
    if (
      typeof (error as { code?: string }).code === 'string' &&
      (error as { code: string }).code === 'P2002'
    ) {
      return NextResponse.json({ error: 'Address already whitelisted' }, { status: 409 })
    }
    logger.error({ err: error }, 'POST /api/routes-d/whitelist/addresses error')
    return NextResponse.json({ error: 'Failed to add whitelist address' }, { status: 500 })
  }
}
