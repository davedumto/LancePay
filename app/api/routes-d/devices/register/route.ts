import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_PLATFORMS = ['ios', 'android', 'web'] as const
type Platform = typeof VALID_PLATFORMS[number]

const MAX_TOKEN_LENGTH = 512

type DeviceDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getDeviceDelegate(): DeviceDelegate {
  return (prisma as unknown as { device: DeviceDelegate }).device
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const b = body as Record<string, unknown>

    const token = typeof b?.token === 'string' ? b.token.trim() : ''
    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      return NextResponse.json({ error: `token must be at most ${MAX_TOKEN_LENGTH} characters` }, { status: 400 })
    }

    const platform = typeof b?.platform === 'string' ? b.platform.toLowerCase() : ''
    if (!VALID_PLATFORMS.includes(platform as Platform)) {
      return NextResponse.json(
        { error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` },
        { status: 400 },
      )
    }

    const deviceName = typeof b?.deviceName === 'string' ? b.deviceName.trim().slice(0, 200) : null

    const delegate = getDeviceDelegate()

    const existing = await delegate.findFirst({
      where: { userId: user.id, token },
    })

    if (existing) {
      const updated = await delegate.update({
        where: { id: (existing as { id: string }).id },
        data: { platform, deviceName, updatedAt: new Date() },
        select: { id: true, token: true, platform: true, deviceName: true, createdAt: true, updatedAt: true },
      })
      return NextResponse.json({ device: updated })
    }

    const device = await delegate.create({
      data: {
        userId: user.id,
        token,
        platform,
        deviceName,
      },
      select: { id: true, token: true, platform: true, deviceName: true, createdAt: true },
    })

    return NextResponse.json({ device }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/devices/register error')
    return NextResponse.json({ error: 'Failed to register device' }, { status: 500 })
  }
}
