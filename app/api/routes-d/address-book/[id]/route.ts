import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/routes-d/address-book/[id] — remove an address book entry

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const db = prisma as unknown as {
  addressBook: {
    findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const {} = await params
    if (!id || typeof id !== 'string' || !id.trim()) {
      return NextResponse.json({ error: 'Entry ID is required' }, { status: 400 })
    }

    const entry = await db.addressBook.findFirst({
      where: { id, userId: user.id },
    })

    if (!entry) {
      return NextResponse.json({ error: 'Address book entry not found' }, { status: 404 })
    }

    await db.addressBook.delete({ where: { id } })

    logger.info({ userId: user.id, entryId: id }, 'DELETE /api/routes-d/address-book/[id]')
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/address-book/[id] error')
    return NextResponse.json({ error: 'Failed to delete address book entry' }, { status: 500 })
  }
}
