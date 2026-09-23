import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/invoice-collaborators/[id]/permissions
// Resolves what an InvoiceCollaborator may do given their assigned role.

type PermissionSet = { canEdit: boolean; canComment: boolean; canDelete: boolean }

const ROLE_PERMISSIONS: Record<string, PermissionSet> = {
  admin: { canEdit: true, canComment: true, canDelete: true },
  editor: { canEdit: true, canComment: true, canDelete: false },
  commenter: { canEdit: false, canComment: true, canDelete: false },
  viewer: { canEdit: false, canComment: false, canDelete: false },
}

// Fall back to the most restrictive set for any unrecognized role value.
const RESTRICTED_PERMISSIONS: PermissionSet = {
  canEdit: false,
  canComment: false,
  canDelete: false,
}

function resolvePermissions(role: string): PermissionSet {
  return ROLE_PERMISSIONS[role] ?? RESTRICTED_PERMISSIONS
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Collaborator ID is required' }, { status: 400 })
    }

    const collaborator = await prisma.invoiceCollaborator.findUnique({
      where: { id },
      include: { invoice: { select: { id: true, userId: true } } },
    })
    if (!collaborator) {
      return NextResponse.json({ error: 'Invoice collaborator not found' }, { status: 404 })
    }

    // Only the invoice owner or the collaborator themselves may read this.
    const isOwner = collaborator.invoice.userId === user.id
    const isCollaborator = collaborator.subContractorId === user.id
    if (!isOwner && !isCollaborator) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({
      collaboratorId: collaborator.id,
      invoiceId: collaborator.invoiceId,
      role: collaborator.role,
      permissions: resolvePermissions(collaborator.role),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoice-collaborators/[id]/permissions error')
    return NextResponse.json({ error: 'Failed to resolve collaborator permissions' }, { status: 500 })
  }
}
