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

    const devices = await (prisma as any).trustedDevice.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        name: true,
        userAgent: true,
        lastSeenAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ devices })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/auth/trusted-devices error')
    return NextResponse.json({ error: 'Failed to fetch trusted devices' }, { status: 500 })
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

    const body = await request.json()
    const { name } = body

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: 'Device name is required' }, { status: 400 })
    }

    const userAgent = request.headers.get('user-agent') ?? 'unknown'

    const device = await (prisma as any).trustedDevice.create({
      data: {
        userId: user.id,
        name: name.trim(),
        userAgent,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        userAgent: true,
        lastSeenAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ device }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/trusted-devices error')
    return NextResponse.json({ error: 'Failed to add trusted device' }, { status: 500 })
  }
}
