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
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const methods = await prisma.payoutMethod.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, label: true, isDefault: true, createdAt: true },
    })

    return NextResponse.json({ payoutMethods: methods })
  } catch (error) {
    logger.error({ err: error }, 'GET /payout-methods error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: { type?: unknown; label?: unknown; details?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { type, label, details } = body
    if (typeof type !== 'string' || !type.trim()) {
      return NextResponse.json({ error: 'type is required' }, { status: 422 })
    }
    if (typeof label !== 'string' || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 422 })
    }

    const existing = await prisma.payoutMethod.count({ where: { userId: user.id } })

    const method = await prisma.payoutMethod.create({
      data: {
        userId: user.id,
        type: type.trim(),
        label: label.trim(),
        details: details ?? {},
        isDefault: existing === 0,
      },
      select: { id: true, type: true, label: true, isDefault: true, createdAt: true },
    })

    logger.info({ userId: user.id, methodId: method.id, type }, 'Payout method added')

    return NextResponse.json({ payoutMethod: method }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /payout-methods error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
