import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/system/health — system health check ──
//
// Public endpoint (no auth required) that verifies database connectivity
// and returns a structured health payload. Returns 200 when healthy and
// 503 when the database is unreachable.

export async function GET() {
  const start = Date.now()
  try {
    await (prisma as unknown as { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }).$queryRaw`SELECT 1`
    const dbLatencyMs = Date.now() - start

    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: 'ok', latencyMs: dbLatencyMs },
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/system/health db check failed')
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: 'error', error: 'Database unreachable' },
        },
      },
      { status: 503 },
    )
  }
}
