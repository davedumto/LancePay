import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_MENTIONS = 20

type MentionDelegate = {
  createMany: (args: Record<string, unknown>) => Promise<{ count: number }>
}

type CommentDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getMentionDelegate(): MentionDelegate {
  return (prisma as unknown as { commentMention: MentionDelegate }).commentMention
}

function getCommentDelegate(): CommentDelegate {
  return (prisma as unknown as { comment: CommentDelegate }).comment
}

function parseMentions(text: string): string[] {
  const matches = text.match(/@([a-zA-Z0-9_]+)/g)
  if (!matches) return []
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))]
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

export async function POST(
  request: NextRequest,
  { params }: any,
) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const commentId = (await params).
  if (!commentId || !commentId.trim()) {
    return NextResponse.json({ error: 'Comment id is required' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const commentDelegate = getCommentDelegate()
  const comment = await commentDelegate.findFirst({
    where: { id: commentId },
    select: { id: true },
  })
  if (!comment) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  // Accept explicit mentions array, or parse from a text field.
  let mentionedUsernames: string[] = []
  if (Array.isArray(payload.mentions)) {
    mentionedUsernames = payload.mentions
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean)
  } else if (typeof payload.text === 'string') {
    mentionedUsernames = parseMentions(payload.text)
  }

  if (mentionedUsernames.length === 0) {
    return NextResponse.json({ error: 'No mentions found in request' }, { status: 400 })
  }

  if (mentionedUsernames.length > MAX_MENTIONS) {
    return NextResponse.json(
      { error: `At most ${MAX_MENTIONS} mentions are allowed per comment` },
      { status: 400 },
    )
  }

  const mentionDelegate = getMentionDelegate()
  const result = await mentionDelegate.createMany({
    data: mentionedUsernames.map((username) => ({
      commentId,
      mentionedUsername: username,
      mentionedById: userId,
    })),
    skipDuplicates: true,
  })

  return NextResponse.json(
    {
      commentId,
      mentionsRecorded: result.count,
      mentionedUsernames,
    },
    { status: 201 },
  )
}
