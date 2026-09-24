import { createHash, randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

async function authenticatedUser(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const claims = await verifyAuthToken(token)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await authenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const verifications = await prisma.incomeVerification.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        recipientName: true,
        expiresAt: true,
        accessCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ verifications })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/income-verifications error')
    return NextResponse.json({ error: 'Failed to fetch income verifications' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await authenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (typeof body.expiresAt !== 'string' || !body.expiresAt.trim()) {
      return NextResponse.json({ error: 'expiresAt is required' }, { status: 400 })
    }
    const expiresAt = new Date(body.expiresAt)
    const lifetime = expiresAt.getTime() - Date.now()
    if (!Number.isFinite(expiresAt.getTime()) || lifetime <= 0 || lifetime > MAX_EXPIRY_MS) {
      return NextResponse.json(
        { error: 'expiresAt must be in the future and no more than 30 days away' },
        { status: 400 },
      )
    }
    const recipientName = typeof body.recipientName === 'string' && body.recipientName.trim()
      ? body.recipientName.trim()
      : null
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const verification = await prisma.incomeVerification.create({
      data: {
        userId: user.id,
        tokenHash,
        recipientName,
        expiresAt,
        accessCount: 0,
      },
      select: {
        id: true,
        recipientName: true,
        expiresAt: true,
        accessCount: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ verification, token: rawToken }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/income-verifications error')
    return NextResponse.json({ error: 'Failed to create income verification' }, { status: 500 })
  }
}
