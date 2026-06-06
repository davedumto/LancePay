import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { invalidateDashboardCache } from '../../_shared/cache'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user ?? null
}

function isValidIsoDate(value: string) {
  const date = new Date(value)
  return !Number.isNaN(date.getTime())
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.clientName,
        clientEmail: invoice.clientEmail,
        description: invoice.description,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        paymentLink: invoice.paymentLink,
        dueDate: invoice.dueDate,
        paidAt: invoice.paidAt,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/invoices/[id] error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (invoice.status !== 'pending') {
      return NextResponse.json(
        { error: 'Only pending invoices can be edited' },
        { status: 422 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const updateData: {
      description?: string
      amount?: number
      dueDate?: Date | null
      clientName?: string | null
    } = {}

    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.trim() === '') {
        return NextResponse.json(
          { error: 'description must be a non-empty string' },
          { status: 400 },
        )
      }
      if (body.description.length > 500) {
        return NextResponse.json(
          { error: 'description must be 500 characters or fewer' },
          { status: 400 },
        )
      }
      updateData.description = body.description.trim()
    }

    if (body.amount !== undefined) {
      const parsed = Number(body.amount)
      if (typeof body.amount !== 'number' || Number.isNaN(parsed) || parsed <= 0) {
        return NextResponse.json(
          { error: 'amount must be a positive number' },
          { status: 400 },
        )
      }
      updateData.amount = parsed
    }

    if (body.dueDate !== undefined) {
      if (body.dueDate === null) {
        updateData.dueDate = null
      } else if (typeof body.dueDate === 'string' && isValidIsoDate(body.dueDate)) {
        updateData.dueDate = new Date(body.dueDate)
      } else {
        return NextResponse.json(
          { error: 'dueDate must be a valid ISO date string or null' },
          { status: 400 },
        )
      }
    }

    if (body.clientName !== undefined) {
      if (body.clientName === null) {
        updateData.clientName = null
      } else if (typeof body.clientName !== 'string') {
        return NextResponse.json({ error: 'clientName must be a string' }, { status: 400 })
      } else if (body.clientName.length > 100) {
        return NextResponse.json(
          { error: 'clientName must be 100 characters or fewer' },
          { status: 400 },
        )
      } else {
        updateData.clientName = body.clientName
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: updateData,
      select: {
        id: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    invalidateDashboardCache(user.id)

    return NextResponse.json({ invoice: { ...updated, amount: Number(updated.amount) } })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/invoices/[id] error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
