import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type WhitelistDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getWhitelistDelegate(): WhitelistDelegate {
  return (prisma as unknown as { whitelistAddress: WhitelistDelegate }).whitelistAddress
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getWhitelistDelegate()

    const entry = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true },
    })

    if (!entry) {
      return NextResponse.json({ error: 'Address not found' }, { status: 404 })
    }

    if ((entry as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    await delegate.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/whitelist/addresses/[id] error')
    return NextResponse.json({ error: 'Failed to remove whitelist address' }, { status: 500 })
  }
}
