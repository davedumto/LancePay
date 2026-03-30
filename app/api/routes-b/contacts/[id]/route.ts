import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * DELETE /api/routes-b/contacts/[id]
 * Permanently removes a contact from the user's list.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { id } = await params

    // Find contact by id
    const contact = await prisma.contact.findUnique({
      where: { id },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Authorization check: verify ownership
    if (contact.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Delete the contact
    await prisma.contact.delete({
      where: { id },
    })

    // Return 204 No Content
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    const { id } = await params
    logger.error({ err: error, contactId: id }, 'Routes B contact DELETE error')
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 })
  }
}
