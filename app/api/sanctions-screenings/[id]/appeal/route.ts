import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await context.params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return NextResponse.json({ error: 'appeal reason is required' }, { status: 400 })

    const screening = await prisma.sanctionsScreening.findUnique({ where: { id } })
    if (!screening || screening.userId !== user.id) {
      return NextResponse.json({ error: 'Sanctions screening not found' }, { status: 404 })
    }
    if (screening.status === 'clear') {
      return NextResponse.json({ error: 'Clear screenings cannot be appealed' }, { status: 409 })
    }
    if (screening.status !== 'flagged' && screening.status !== 'under_review') {
      return NextResponse.json({ error: 'Screening is not eligible for appeal' }, { status: 409 })
    }

    const pending = await prisma.sanctionsAppeal.findFirst({
      where: { screeningId: id, status: 'pending' },
      select: { id: true },
    })
    if (pending) {
      return NextResponse.json({ error: 'A pending appeal already exists' }, { status: 409 })
    }

    try {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const appeal = await tx.sanctionsAppeal.create({
          data: { screeningId: id, userId: user.id, reason, status: 'pending' },
        })
        const updatedScreening = await tx.sanctionsScreening.update({
          where: { id },
          data: { status: 'under_review' },
        })
        return { appeal, screening: updatedScreening }
      })
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json({ error: 'A pending appeal already exists' }, { status: 409 })
      }
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/sanctions-screenings/[id]/appeal error')
    return NextResponse.json({ error: 'Failed to submit sanctions appeal' }, { status: 500 })
  }
}
