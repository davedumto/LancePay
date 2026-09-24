import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

async function readBody(request: NextRequest) {
  const text = await request.text()
  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const type = new URL(request.url).searchParams.get('type')?.trim()
    const entries = await prisma.securityWatchlist.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ entries })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/security-watchlist error')
    return NextResponse.json({ error: 'Failed to fetch security watchlist' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    let body: Record<string, unknown>
    try {
      body = await readBody(request)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const type = typeof body.type === 'string' ? body.type.trim() : ''
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!type) return NextResponse.json({ error: 'type is required' }, { status: 400 })
    if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 })
    if (!reason) return NextResponse.json({ error: 'reason is required' }, { status: 400 })

    try {
      const entry = await prisma.securityWatchlist.create({ data: { type, value, reason } })
      return NextResponse.json({ entry }, { status: 201 })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json({ error: 'Watchlist value already exists' }, { status: 409 })
      }
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/security-watchlist error')
    return NextResponse.json({ error: 'Failed to create security watchlist entry' }, { status: 500 })
  }
}
