/**
 * POST /api/routes-b/tags/[id]/rename — Issue #610
 *
 * Rename a tag in a single atomic UPDATE. References to the tag are preserved.
 * Returns 409 with `mergeIntoId` hint when another tag with the new name
 * already exists for the same user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { validateTagName } from '../../../_lib/tag-validation'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 1. Auth
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // 2. Parse and validate body
  const { id } = await params
  let body: { newName?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validation = validateTagName(body.newName)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }
  const newName = validation.value

  // 3. Verify ownership of the source tag
  const tag = await prisma.tag.findUnique({ where: { id } })
  if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
  if (tag.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // No-op if name unchanged
  if (tag.name === newName) {
    return NextResponse.json({ id: tag.id, name: tag.name, renamed: false })
  }

  // 4. Conflict check — does the user already have a tag with newName?
  const existing = await prisma.tag.findFirst({
    where: { userId: user.id, name: newName, NOT: { id } },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      {
        error: 'A tag with that name already exists',
        mergeIntoId: existing.id,
      },
      { status: 409 },
    )
  }

  // 5. Atomic rename — single UPDATE
  const updated = await prisma.tag.update({
    where: { id },
    data: { name: newName },
    select: { id: true, name: true, color: true },
  })

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    color: updated.color,
    renamed: true,
  })
}
