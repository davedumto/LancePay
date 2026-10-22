import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_DEFAULT_NETWORKS = ['stellar', 'bank']
const VALID_STELLAR_NETWORKS = ['public', 'testnet']

const DEFAULTS = {
  defaultNetwork: 'stellar',
  stellarNetwork: 'public',
  congestionAlerts: true,
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const preferences = await (prisma as any).networkPreference.findUnique({
      where: { userId: user.id },
    })

    return NextResponse.json({
      preferences: preferences
        ? {
            defaultNetwork: preferences.defaultNetwork,
            stellarNetwork: preferences.stellarNetwork,
            congestionAlerts: preferences.congestionAlerts,
            updatedAt: preferences.updatedAt,
          }
        : { ...DEFAULTS, updatedAt: null },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/networks/preferences error')
    return NextResponse.json({ error: 'Failed to fetch network preferences' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { defaultNetwork, stellarNetwork, congestionAlerts } = body

    const updates: Record<string, unknown> = {}

    if (defaultNetwork !== undefined) {
      if (!VALID_DEFAULT_NETWORKS.includes(defaultNetwork)) {
        return NextResponse.json(
          { error: `Invalid defaultNetwork. Supported: ${VALID_DEFAULT_NETWORKS.join(', ')}` },
          { status: 400 },
        )
      }
      updates.defaultNetwork = defaultNetwork
    }

    if (stellarNetwork !== undefined) {
      if (!VALID_STELLAR_NETWORKS.includes(stellarNetwork)) {
        return NextResponse.json(
          { error: `Invalid stellarNetwork. Supported: ${VALID_STELLAR_NETWORKS.join(', ')}` },
          { status: 400 },
        )
      }
      updates.stellarNetwork = stellarNetwork
    }

    if (congestionAlerts !== undefined) {
      if (typeof congestionAlerts !== 'boolean') {
        return NextResponse.json(
          { error: 'congestionAlerts must be a boolean' },
          { status: 400 },
        )
      }
      updates.congestionAlerts = congestionAlerts
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'At least one field must be provided' },
        { status: 400 },
      )
    }

    const preferences = await (prisma as any).networkPreference.upsert({
      where: { userId: user.id },
      update: updates,
      create: { userId: user.id, ...DEFAULTS, ...updates },
    })

    return NextResponse.json({
      preferences: {
        defaultNetwork: preferences.defaultNetwork,
        stellarNetwork: preferences.stellarNetwork,
        congestionAlerts: preferences.congestionAlerts,
        updatedAt: preferences.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/networks/preferences error')
    return NextResponse.json({ error: 'Failed to update network preferences' }, { status: 500 })
  }
}
