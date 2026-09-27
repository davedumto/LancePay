import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/routes-d/auth/trusted-devices/[id] — revoke a trusted device

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

const db = prisma as unknown as {
  trustedDevice: {
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
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Device ID is required' }, { status: 400 })
    }

    const device = await db.trustedDevice.findFirst({
      where: { id, userId: user.id },
    })

    if (!device) {
      return NextResponse.json({ error: 'Trusted device not found' }, { status: 404 })
    }

    await db.trustedDevice.delete({ where: { id } })

    logger.info({ userId: user.id, deviceId: id }, 'DELETE /api/routes-d/auth/trusted-devices/[id]')
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/auth/trusted-devices/[id] error')
    return NextResponse.json({ error: 'Failed to revoke trusted device' }, { status: 500 })
  }
}
