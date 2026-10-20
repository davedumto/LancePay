import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const settings = await prisma.digestEmailSettings.findUnique({
      where: { userId: user.id },
    })

    return NextResponse.json({
      settings: settings ?? {
        enabled: true,
        frequency: 'weekly',
        lastSentAt: null,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/settings/digest-email error')
    return NextResponse.json({ error: 'Failed to get digest email settings' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { enabled, frequency } = (body ?? {}) as {
      enabled?: boolean
      frequency?: string
    }

    if (
      frequency !== undefined &&
      !VALID_FREQUENCIES.includes(frequency as (typeof VALID_FREQUENCIES)[number])
    ) {
      return NextResponse.json(
        { error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` },
        { status: 400 },
      )
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }

    const settings = await prisma.digestEmailSettings.upsert({
      where: { userId: user.id },
      update: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(frequency !== undefined ? { frequency } : {}),
      },
      create: {
        userId: user.id,
        enabled: enabled ?? true,
        frequency: frequency ?? 'weekly',
      },
    })

    return NextResponse.json({ settings })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/settings/digest-email error')
    return NextResponse.json({ error: 'Failed to update digest email settings' }, { status: 500 })
  }
}
