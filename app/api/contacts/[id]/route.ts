import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

/**
 * DELETE /api/contacts/[id]
 * Soft-deletes a contact by setting `deletedAt`; the row is kept so historical
 * invoice references stay intact.
 *
 * Returns 404 when the contact does not exist, belongs to another user, or is
 * already soft-deleted. Another user's contact is deliberately
 * indistinguishable from a missing one.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    // One conditional write: ownership and "not already deleted" are enforced
    // atomically, so concurrent deletes cannot both succeed.
    const result = await prisma.contact.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    })

    if (result.count === 0) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/contacts/[id] error')
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 })
  }
}
