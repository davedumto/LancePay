import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; contactId: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const client = await prisma.client.findFirst({
      where: { id: (await params).id, userId: user.id },
    })
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const contact = await prisma.clientContact.findFirst({
      where: { id: (await params).contactId, clientId: (await params).id },
      select: { id: true },
    })
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    await prisma.clientContact.delete({ where: { id: (await params).contactId } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-b/clients/[id]/contacts/[contactId] error')
    return NextResponse.json({ error: 'Failed to remove contact' }, { status: 500 })
  }
}
