import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { checkRateLimit } from '../../_lib/rate-limit'

export async function POST(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const rateLimitKey = `tag-sweep:${user.id}`
  const rateLimitResult = checkRateLimit(rateLimitKey, { limit: 1, windowMs: 60 * 1000 })
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limited. Maximum 1 sweep per minute.' },
      { status: 429 },
    )
  }

  const result = await prisma.$transaction(async (tx) => {
    const allUserTags = await tx.tag.findMany({
      where: { userId: user.id },
      select: { id: true },
    })

    const referencedTagIds = await tx.invoiceTag.findMany({
      where: {
        invoice: {
          userId: user.id,
        },
      },
      distinct: ['tagId'],
      select: { tagId: true },
    })

    const referencedIdSet = new Set(referencedTagIds.map((t) => t.tagId))
    const unusedIds = allUserTags.filter((t) => !referencedIdSet.has(t.id)).map((t) => t.id)

    if (unusedIds.length === 0) {
      return { deletedCount: 0, deletedIds: [] }
    }

    await tx.tag.deleteMany({
      where: {
        id: { in: unusedIds },
        userId: user.id,
      },
    })

    return {
      deletedCount: unusedIds.length,
      deletedIds: unusedIds,
    }
  })

  return NextResponse.json(result)
}
