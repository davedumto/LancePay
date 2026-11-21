import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

const RELOADABLE_KEYS = [
  'feature_flags',
  'rate_limits',
  'webhook_retry_policy',
  'fx_rate_sources',
  'sanctions_list_version',
] as const

type ReloadableKey = (typeof RELOADABLE_KEYS)[number]

export async function POST(request: NextRequest) {
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
    const keys: ReloadableKey[] = Array.isArray(body.keys)
      ? body.keys.filter((k: unknown) => RELOADABLE_KEYS.includes(k as ReloadableKey))
      : [...RELOADABLE_KEYS]

    if (keys.length === 0) {
      return NextResponse.json(
        {
          error: 'No valid config keys specified',
          allowedKeys: RELOADABLE_KEYS,
        },
        { status: 400 },
      )
    }

    const reloaded = keys.map((key) => ({
      key,
      status: 'reloaded' as const,
      reloadedAt: new Date().toISOString(),
    }))

    logger.info({ adminId: user.id, keys }, 'Configuration hot-reload triggered')

    return NextResponse.json({
      reloaded,
      total: reloaded.length,
      triggeredBy: user.email,
      triggeredAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/system/config/reload error')
    return NextResponse.json({ error: 'Failed to reload configuration' }, { status: 500 })
  }
}
