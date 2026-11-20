import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

const VALID_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type LogLevel = typeof VALID_LEVELS[number]

let currentLogLevel: LogLevel = 'info'

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { level } = body

    if (!level || typeof level !== 'string') {
      return NextResponse.json(
        { error: 'level is required', validLevels: VALID_LEVELS },
        { status: 400 },
      )
    }

    if (!VALID_LEVELS.includes(level as LogLevel)) {
      return NextResponse.json(
        { error: `Invalid log level. Must be one of: ${VALID_LEVELS.join(', ')}` },
        { status: 400 },
      )
    }

    const previousLevel = currentLogLevel
    currentLogLevel = level as LogLevel

    logger.info({ adminId: user.id, previousLevel, newLevel: level }, 'Runtime log level changed')

    return NextResponse.json({
      previousLevel,
      currentLevel: currentLogLevel,
      changedBy: user.email,
      changedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/system/log-level error')
    return NextResponse.json({ error: 'Failed to update log level' }, { status: 500 })
  }
}
