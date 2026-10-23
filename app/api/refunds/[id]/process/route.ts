import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const admin = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!admin) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (admin.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const status = (body as Record<string, unknown> | null)?.status
    if (status !== 'completed' && status !== 'failed') {
      return NextResponse.json({ error: 'status must be completed or failed' }, { status: 400 })
    }

    const { id } = await params
    const updated = await prisma.refund.updateMany({
      where: { id, status: 'pending' },
      data: { status },
    })
    if (updated.count === 0) {
      const refund = await prisma.refund.findUnique({ where: { id }, select: { status: true } })
      if (!refund) return NextResponse.json({ error: 'Refund not found' }, { status: 404 })
      return NextResponse.json({ error: `Refund in status '${refund.status}' cannot be processed` }, { status: 409 })
    }

    return NextResponse.json({ refund: { id, status } })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/refunds/[id]/process error')
    return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 })
  }
}