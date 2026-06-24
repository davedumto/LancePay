import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_ID_TYPES = ['passport', 'national_id', 'drivers_license'] as const
type IdType = typeof VALID_ID_TYPES[number]

type KycDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  upsert: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getKycDelegate(): KycDelegate {
  return (prisma as unknown as { kycApplication: KycDelegate }).kycApplication
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const rawIdType = (body as { idType?: unknown } | null)?.idType
    if (rawIdType !== undefined && !VALID_ID_TYPES.includes(rawIdType as IdType)) {
      return NextResponse.json({ error: 'Invalid idType' }, { status: 400 })
    }
    const idType: IdType = (rawIdType as IdType) ?? 'national_id'

    const kyc = getKycDelegate()
    const existing = await kyc.findUnique({ where: { userId: user.id } })

    if (existing) {
      const status = existing.status as string
      if (status === 'pending') {
        return NextResponse.json({ error: 'Identity verification already pending' }, { status: 409 })
      }
      if (status === 'approved') {
        return NextResponse.json({ error: 'Identity already verified' }, { status: 409 })
      }
    }

    const verification = await kyc.upsert({
      where: { userId: user.id },
      create: { userId: user.id, status: 'pending', level: idType },
      update: { status: 'pending', level: idType },
      select: { id: true, status: true, level: true, createdAt: true },
    })

    return NextResponse.json({ verification }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'identity verification error')
    return NextResponse.json({ error: 'Failed to start identity verification' }, { status: 500 })
  }
}
