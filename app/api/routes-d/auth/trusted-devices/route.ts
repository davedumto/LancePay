import { isIP } from 'net'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_LABEL_LENGTH = 100
const MAX_USER_AGENT_LENGTH = 500

async function authenticate(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 401 }) }
  }

  return { user }
}

const deviceSelect = {
  id: true,
  label: true,
  userAgent: true,
  ipAddress: true,
  lastSeenAt: true,
  createdAt: true,
} as const

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    const devices = await prisma.trustedDevice.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'desc' },
      select: deviceSelect,
    })

    return NextResponse.json({ devices })
  } catch (error) {
    logger.error({ err: error }, 'GET /auth/trusted-devices error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { label, userAgent, ipAddress } = (body ?? {}) as {
      label?: unknown
      userAgent?: unknown
      ipAddress?: unknown
    }

    if (typeof label !== 'string' || label.trim() === '') {
      return NextResponse.json({ error: 'label must be a non-empty string' }, { status: 400 })
    }
    if (label.trim().length > MAX_LABEL_LENGTH) {
      return NextResponse.json(
        { error: `label must be at most ${MAX_LABEL_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (userAgent !== undefined && typeof userAgent !== 'string') {
      return NextResponse.json({ error: 'userAgent must be a string' }, { status: 400 })
    }
    if (typeof userAgent === 'string' && userAgent.length > MAX_USER_AGENT_LENGTH) {
      return NextResponse.json(
        { error: `userAgent must be at most ${MAX_USER_AGENT_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (ipAddress !== undefined && (typeof ipAddress !== 'string' || isIP(ipAddress) === 0)) {
      return NextResponse.json(
        { error: 'ipAddress must be a valid IPv4 or IPv6 address' },
        { status: 400 },
      )
    }

    const device = await prisma.trustedDevice.create({
      data: {
        userId: auth.user.id,
        label: label.trim(),
        userAgent: typeof userAgent === 'string' ? userAgent : null,
        ipAddress: typeof ipAddress === 'string' ? ipAddress : null,
      },
      select: deviceSelect,
    })

    return NextResponse.json({ device }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /auth/trusted-devices error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
