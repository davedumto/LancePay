import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

export async function GET() {
  try {
    const packageJson = await import('../../../../../package.json')

    return NextResponse.json({
      version: packageJson.version,
      name: packageJson.name,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'unknown',
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/system/build-info error')
    return NextResponse.json({ error: 'Failed to retrieve build info' }, { status: 500 })
  }
}
