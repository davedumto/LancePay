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

    let body: { description?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { description } = body

    if (!description || typeof description !== 'string' || description.trim() === '') {
      return NextResponse.json(
        { error: 'Description is required and must be a non-empty string' },
        { status: 400 }
      )
    }

    // validation: max length
    if (description.length > 500) {
      return NextResponse.json(
        { error: 'Description must not exceed 500 characters' },
        { status: 400 }
      )
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
        { error: 'Only pending invoices can be updated' },
        { status: 422 }
      )
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id },
      data: {
        description: description.trim(),
      },
      select: {
        id: true,
        invoiceNumber: true,
        description: true,
        updatedAt: true,
      },
    })

    invalidateDashboardCache(user.id)

    return NextResponse.json(updatedInvoice, { status: 200 })

  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/invoices/[id]/description error')
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}
