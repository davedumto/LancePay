import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

// POST /api/routes-d/admin/backups/trigger — trigger a manual system backup (admin only)

async function getAuthenticatedAdmin(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}

const db = prisma as unknown as {
  backup: {
    create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedAdmin(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const userWithRole = user as { id: string; role?: string }
    if (!isAdmin(userWithRole)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      label?: string
      type?: string
    }

    const VALID_TYPES = ['full', 'incremental']
    const backupType = body.type && VALID_TYPES.includes(body.type) ? body.type : 'full'
    const label = typeof body.label === 'string' ? body.label.trim() || null : null

    const backup = await db.backup.create({
      data: {
        type: backupType,
        label,
        status: 'queued',
        triggeredBy: user.id,
      },
      select: { id: true, type: true, label: true, status: true, createdAt: true },
    })

    logger.info({ userId: user.id, backupId: backup.id, type: backupType }, 'POST /api/routes-d/admin/backups/trigger')
    return NextResponse.json({ backup }, { status: 202 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/backups/trigger error')
    return NextResponse.json({ error: 'Failed to trigger backup' }, { status: 500 })
  }
}
