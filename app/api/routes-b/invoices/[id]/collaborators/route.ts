import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/invoices/[id]/collaborators — list invoice collaborators
// POST /api/routes-b/invoices/[id]/collaborators — add an invoice collaborator

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

async function findOwnedInvoice(invoiceId: string, userId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true, amount: true, currency: true, status: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const collaborators = await prisma.invoiceCollaborator.findMany({
      where: { invoiceId },
      include: {
        subContractor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({ collaborators })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/collaborators error')
    return NextResponse.json({ error: 'Failed to fetch invoice collaborators' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as {
      subContractorId?: string
      email?: string
      sharePercentage?: number
      paymentSource?: string
    }

    const { sharePercentage, paymentSource } = payload

    if (
      typeof sharePercentage !== 'number' ||
      !Number.isFinite(sharePercentage) ||
      sharePercentage <= 0 ||
      sharePercentage > 100
    ) {
      return NextResponse.json(
        { error: 'sharePercentage must be a number greater than 0 and at most 100' },
        { status: 400 },
      )
    }

    let subContractorId = payload.subContractorId
    if (!subContractorId && payload.email) {
      if (typeof payload.email !== 'string' || !payload.email.trim()) {
        return NextResponse.json({ error: 'Invalid email provided' }, { status: 400 })
      }
      const subUser = await prisma.user.findUnique({
        where: { email: payload.email.trim().toLowerCase() },
        select: { id: true },
      })
      if (!subUser) {
        return NextResponse.json({ error: 'Subcontractor user not found' }, { status: 404 })
      }
      subContractorId = subUser.id
    } else if (subContractorId) {
      if (typeof subContractorId !== 'string' || !subContractorId.trim()) {
        return NextResponse.json({ error: 'subContractorId must be a non-empty string' }, { status: 400 })
      }
      const subUser = await prisma.user.findUnique({
        where: { id: subContractorId },
        select: { id: true },
      })
      if (!subUser) {
        return NextResponse.json({ error: 'Subcontractor user not found' }, { status: 404 })
      }
    } else {
      return NextResponse.json(
        { error: 'subContractorId or email is required' },
        { status: 400 },
      )
    }

    if (subContractorId === user.id) {
      return NextResponse.json(
        { error: 'Cannot add invoice owner as a collaborator' },
        { status: 400 },
      )
    }

    const existingCollaborators = await prisma.invoiceCollaborator.findMany({
      where: { invoiceId },
      select: { subContractorId: true, sharePercentage: true },
    })

    if (existingCollaborators.some((c) => c.subContractorId === subContractorId)) {
      return NextResponse.json(
        { error: 'Collaborator already added to this invoice' },
        { status: 409 },
      )
    }

    const currentTotalShare = existingCollaborators.reduce(
      (sum, c) => sum + Number(c.sharePercentage),
      0,
    )

    if (currentTotalShare + sharePercentage > 100) {
      return NextResponse.json(
        {
          error: `Total collaborator share cannot exceed 100%. Remaining available share is ${(
            100 - currentTotalShare
          ).toFixed(2)}%`,
        },
        { status: 400 },
      )
    }

    const collaborator = await prisma.invoiceCollaborator.create({
      data: {
        invoiceId,
        subContractorId,
        sharePercentage,
        paymentSource: paymentSource ?? 'payment',
        payoutStatus: 'pending',
      },
      include: {
        subContractor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    })

    logger.info(
      { userId: user.id, invoiceId, collaboratorId: collaborator.id },
      'POST /api/routes-b/invoices/[id]/collaborators',
    )

    return NextResponse.json({ collaborator }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/collaborators error')
    return NextResponse.json({ error: 'Failed to add invoice collaborator' }, { status: 500 })
  }
}
