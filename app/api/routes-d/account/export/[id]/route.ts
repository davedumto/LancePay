import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/account/export/[id] — download a specific data export ──
//
// Returns metadata and a download URL for a specific data export by id.
// Pending/processing exports return 202 so the client can poll.
// Failed exports return 422 to distinguish from transient errors.
// Exports belonging to another user return 403 (not 404) to avoid
// leaking whether the export id exists.

type DataExportDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getExportDelegate(): DataExportDelegate {
  return (prisma as unknown as { dataExport: DataExportDelegate }).dataExport
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params

    const delegate = getExportDelegate()
    const dataExport = await delegate.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        format: true,
        fileUrl: true,
        createdAt: true,
        completedAt: true,
      },
    })

    if (!dataExport) {
      return NextResponse.json({ error: 'Export not found' }, { status: 404 })
    }

    if (dataExport.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const status = dataExport.status as string

    if (status === 'pending' || status === 'processing') {
      return NextResponse.json(
        { status, message: 'Export not ready' },
        { status: 202 },
      )
    }

    if (status === 'failed') {
      return NextResponse.json(
        { status: 'failed', error: 'Export generation failed' },
        { status: 422 },
      )
    }

    return NextResponse.json({
      id: dataExport.id,
      status: dataExport.status,
      format: dataExport.format,
      downloadUrl: (dataExport.fileUrl as string | null) ?? null,
      requestedAt: dataExport.createdAt,
      completedAt: (dataExport.completedAt as string | null) ?? null,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/account/export/[id] error')
    return NextResponse.json({ error: 'Failed to retrieve export' }, { status: 500 })
  }
}
