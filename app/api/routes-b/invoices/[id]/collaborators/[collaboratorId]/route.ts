import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// PATCH /api/routes-b/invoices/[id]/collaborators/[collaboratorId]
// Update an InvoiceCollaborator role using optimistic locking so concurrent
// edits cannot silently clobber one another.

const ALLOWED_ROLES = ['viewer', 'editor', 'approver'] as const
type Role = (typeof ALLOWED_ROLES)[number]

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function serialiseCollaborator(collaborator: {
  id: string
  invoiceId: string
  subContractorId: string
  role: string
  sharePercentage: { toString(): string }
  payoutStatus: string
  paymentSource: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: collaborator.id,
    invoiceId: collaborator.invoiceId,
    subContractorId: collaborator.subContractorId,
    role: collaborator.role,
    sharePercentage: collaborator.sharePercentage.toString(),
    payoutStatus: collaborator.payoutStatus,
    paymentSource: collaborator.paymentSource,
    createdAt: collaborator.createdAt.toISOString(),
    updatedAt: collaborator.updatedAt.toISOString(),
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; collaboratorId: string } | Promise<{ id: string; collaboratorId: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId, collaboratorId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }
    if (!collaboratorId || !collaboratorId.trim()) {
      return NextResponse.json({ error: 'Collaborator ID is required' }, { status: 400 })
    }

    // Only the invoice owner may change collaborator roles.
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true },
    })
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
      role?: unknown
      expectedUpdatedAt?: unknown
      version?: unknown
    }

    if (typeof payload.role !== 'string' || !ALLOWED_ROLES.includes(payload.role as Role)) {
      return NextResponse.json(
        { error: `role must be one of: ${ALLOWED_ROLES.join(', ')}` },
        { status: 400 },
      )
    }
    const role = payload.role as Role

    // The caller must supply the last-known updatedAt they read so we can detect
    // a concurrent edit. `version` is accepted as an alias for the same value.
    const rawExpected = payload.expectedUpdatedAt ?? payload.version
    if (typeof rawExpected !== 'string' || !rawExpected.trim()) {
      return NextResponse.json(
        { error: 'expectedUpdatedAt is required for optimistic locking' },
        { status: 400 },
      )
    }
    const expectedUpdatedAt = new Date(rawExpected)
    if (Number.isNaN(expectedUpdatedAt.getTime())) {
      return NextResponse.json(
        { error: 'expectedUpdatedAt must be a valid ISO timestamp' },
        { status: 400 },
      )
    }

    // Optimistic lock: the update only applies when the stored updatedAt still
    // matches the value the caller read. A zero-row update means either the row
    // is gone (404) or it changed underneath us (409).
    const result = await prisma.invoiceCollaborator.updateMany({
      where: { id: collaboratorId, invoiceId, updatedAt: expectedUpdatedAt },
      data: { role },
    })

    if (result.count === 0) {
      const current = await prisma.invoiceCollaborator.findFirst({
        where: { id: collaboratorId, invoiceId },
        select: { id: true, updatedAt: true },
      })
      if (!current) {
        return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 })
      }
      return NextResponse.json(
        {
          error: 'Collaborator was modified since it was last read',
          currentUpdatedAt: current.updatedAt.toISOString(),
        },
        { status: 409 },
      )
    }

    const fresh = await prisma.invoiceCollaborator.findFirst({
      where: { id: collaboratorId, invoiceId },
    })
    if (!fresh) {
      // Extremely unlikely: the row was deleted between update and re-read.
      return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 })
    }

    logger.info(
      { userId: user.id, invoiceId, collaboratorId, role },
      'PATCH /api/routes-b/invoices/[id]/collaborators/[collaboratorId]',
    )

    return NextResponse.json({ collaborator: serialiseCollaborator(fresh) })
  } catch (error) {
    logger.error(
      { err: error },
      'PATCH /api/routes-b/invoices/[id]/collaborators/[collaboratorId] error',
    )
    return NextResponse.json({ error: 'Failed to update collaborator' }, { status: 500 })
  }
}
