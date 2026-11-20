import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

// POST /api/routes-d/admin/backups/restore — trigger a restore
//
// Admin-only endpoint to restore from a backup file.

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
      backupId?: string
      restoreType?: string
    }

    const VALID_RESTORE_TYPES = ['full', 'partial']
    const restoreType = body.restoreType && VALID_RESTORE_TYPES.includes(body.restoreType) 
      ? body.restoreType 
      : 'full'
    const backupId = typeof body.backupId === 'string' ? body.backupId.trim() || null : null

    // Create a restore job record
    const restoreJob = await db.backup.create({
      data: {
        type: 'restore',
        label: `Restore: ${restoreType}${backupId ? ` from ${backupId}` : ''}`,
        status: 'queued',
        triggeredBy: user.id,
      },
      select: { id: true, type: true, label: true, status: true, createdAt: true },
    })

    logger.info({
      userId: user.id,
      restoreJobId: restoreJob.id,
      restoreType,
      backupId,
    }, 'POST /api/routes-d/admin/backups/restore')

    return NextResponse.json({ restoreJob }, { status: 202 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/backups/restore error')
    return NextResponse.json({ error: 'Failed to trigger restore' }, { status: 500 })
  }
}