import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type NoteDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getNoteDelegate(): NoteDelegate {
  return (prisma as unknown as { note: NoteDelegate }).note
}

async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  return user ? user.id : null
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const noteId = (await params).id
  if (!noteId || !noteId.trim()) {
    return NextResponse.json({ error: 'Note id is required' }, { status: 400 })
  }

  const noteDelegate = getNoteDelegate()
  const note = await noteDelegate.findFirst({
    where: { id: noteId, userId },
    select: { id: true, isPinned: true },
  })

  if (!note) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const payload = (body ?? {}) as Record<string, unknown>
  const newPinned = payload.pinned !== undefined ? Boolean(payload.pinned) : !note.isPinned

  const updated = await noteDelegate.update({
    where: { id: noteId },
    data: { isPinned: newPinned },
    select: { id: true, isPinned: true, updatedAt: true },
  })

  return NextResponse.json({
    id: updated.id,
    isPinned: updated.isPinned,
    updatedAt: updated.updatedAt,
  })
}
