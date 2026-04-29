import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const DB_TIMEOUT_MS = 250
const HARD_TIMEOUT_MS = 450
const APP_VERSION = process.env.npm_package_version || 'unknown'

async function checkDbWithTimeout() {
  const dbCheck = prisma.$queryRaw`SELECT 1`
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT_MS)
  })
  await Promise.race([dbCheck, timeout])
}

export async function GET() {
  const startedAt = Date.now()
  const responseTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('HEALTH_TIMEOUT')), HARD_TIMEOUT_MS)
  })

  try {
    await Promise.race([checkDbWithTimeout(), responseTimeout])
    return NextResponse.json(
      {
        ok: true,
        checks: {
          db: 'ok',
          time: new Date(startedAt).toISOString(),
          version: APP_VERSION,
        },
      },
      { status: 200 },
    )
  } catch {
    return NextResponse.json(
      {
        ok: false,
        checks: {
          db: 'degraded',
          time: new Date(startedAt).toISOString(),
          version: APP_VERSION,
        },
      },
      { status: 503 },
    )
  }
}

