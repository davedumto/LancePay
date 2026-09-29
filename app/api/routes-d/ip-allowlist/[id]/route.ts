import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function DELETE(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const {} = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Entry ID is required' }, { status: 400 })
    }

    // Ownership check: only the entry's owner may remove it
    const entry = await prisma.ipAllowlistEntry.findFirst({
      where: { id, userId: user.id },
    })
    if (!entry) {
      return NextResponse.json({ error: 'Allowlist entry not found' }, { status: 404 })
    }

    // Removing the last entry while enforcement is on would lock the user
    // out of nothing (an empty allowlist means "allow all"), but it is a
    // meaningful security downgrade — surface it in the response.
    const remaining = await prisma.ipAllowlistEntry.count({
      where: { userId: user.id, id: { not: id } },
    })

    await prisma.ipAllowlistEntry.delete({ where: { id } })

    return NextResponse.json({
      removed: {
        id: entry.id,
        cidr: entry.cidr,
        label: entry.label ?? null,
      },
      remainingEntries: remaining,
      warning:
        remaining === 0
          ? 'Allowlist is now empty — access is no longer IP-restricted'
          : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/ip-allowlist/[id] error')
    return NextResponse.json({ error: 'Failed to remove allowlist entry' }, { status: 500 })
  }
}
