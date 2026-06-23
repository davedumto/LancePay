import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/system/readiness — readiness probe ──
//
// Used by Kubernetes/load-balancer readiness probes. Returns 200 only
// when all critical dependencies (database) are available. Returns 503
// while the service is starting or degraded. No auth required.

export async function GET() {
  try {
    await (prisma as unknown as { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }).$queryRaw`SELECT 1`

    return NextResponse.json({
      ready: true,
      timestamp: new Date().toISOString(),
      checks: { database: 'ok' },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/system/readiness db check failed')
    return NextResponse.json(
      {
        ready: false,
        timestamp: new Date().toISOString(),
        checks: { database: 'error' },
      },
      { status: 503 },
    )
  }
}
