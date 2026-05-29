import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { invalidateDashboardCache } from '../../../_shared/cache'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
      },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (invoice.status !== 'pending') {
      return NextResponse.json(
        { error: 'Due date can only be updated on pending invoices' },
        { status: 422 }
      )
    }

    let body: { dueDate?: string | null }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!('dueDate' in body)) {
      return NextResponse.json({ error: 'dueDate is required' }, { status: 400 })
    }

    let newDueDate: Date | null = null

    if (body.dueDate !== null) {
      if (typeof body.dueDate !== 'string') {
        return NextResponse.json({ error: 'dueDate must be a string or null' }, { status: 400 })
      }

      const parsed = new Date(body.dueDate)
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: 'Invalid date format' }, { status: 400 })
      }

      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      if (parsed <= today) {
        return NextResponse.json({ error: 'Due date must be a future date' }, { status: 400 })
      }

      newDueDate = parsed
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: { dueDate: newDueDate },
      select: {
        id: true,
        invoiceNumber: true,
        dueDate: true,
      },
    })

    invalidateDashboardCache(user.id)

    return NextResponse.json(updated, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/invoices/[id]/due-date error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
